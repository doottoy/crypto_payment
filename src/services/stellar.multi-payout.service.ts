/* External dependencies */
import { Asset, Horizon, Keypair, Operation, xdr } from '@stellar/stellar-sdk';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { modules } from '../utils/modules';
import { Recipient } from '../interfaces/payout.interface';
import { notifierMessage } from '../utils/message-formatter';
import {
    StellarPayoutError,
    buildStellarAsset,
    buildStellarMemo,
    createHorizonServer,
    describeStellarError,
    extractResultCodes,
    findTrustline,
    healSenderAccount,
    keypairFromSecret,
    loadAccountOrNull,
    resolveStellarDestination,
    submitStellarTransaction,
    toStroops,
    validateStellarAmount
} from '../utils/stellar';

/* Constants */
import { Const } from '../constants/const';
import { StellarSendOptions } from '../interfaces/stellar.payout.interface';

/**
 * Service class for performing multi-send payouts on Stellar.
 *
 * Unlike EVM/Tron there is no multi-send contract: a Stellar transaction is
 * itself a container for up to 100 operations, executed ATOMICALLY (all or
 * nothing). One invalid recipient therefore fails the whole batch, so every
 * destination is pre-flight validated and the batch is rejected with a full
 * per-recipient problem list before anything is submitted.
 *
 * Protocol constraint: a transaction carries a single memo shared by all
 * operations — recipients that require individual memos (exchange deposits)
 * must be paid out one by one via the single-payout endpoint.
 */
export class StellarMultiPayoutService {
    private server!: Horizon.Server;
    private keypair!: Keypair;

    /**
     * @param payway - The payment method being used (e.g. 'stellar').
     * @param privateKey - The sender's secret seed (S...).
     */
    constructor(private payway: string, private privateKey: string) { }

    /**
     * Initializes the Horizon server connection and validates the secret seed.
     */
    async init() {
        this.server = createHorizonServer();
        this.keypair = keypairFromSecret(this.privateKey);
    }

    /**
     * Validates every recipient against the ledger and prepares one operation
     * per recipient. Collects ALL problems instead of failing on the first one
     * so the caller can fix the batch in a single round-trip.
     */
    private async prepareOperations(recipients: Recipient[], asset: Asset): Promise<xdr.Operation[]> {
        const problems: Array<{ address: string; code: string; message: string }> = [];

        const operations = await Promise.all(recipients.map(async (recipient) => {
            try {
                validateStellarAmount(recipient.amount, `amount for ${recipient.address}`);
                const { destination, baseAccountId } = resolveStellarDestination(recipient.address);
                const destinationAccount = await loadAccountOrNull(this.server, baseAccountId);

                if (!destinationAccount) {
                    if (!asset.isNative()) {
                        throw new StellarPayoutError('destination_account_not_found', 'account does not exist on the ledger');
                    }
                    if (toStroops(recipient.amount) < toStroops(Const.STELLAR_MIN_CREATE_ACCOUNT_XLM)) {
                        throw new StellarPayoutError('destination_account_not_found', `account does not exist; auto-creation requires at least ${Const.STELLAR_MIN_CREATE_ACCOUNT_XLM} XLM`);
                    }
                    return Operation.createAccount({ destination: baseAccountId, startingBalance: recipient.amount });
                }

                if (!asset.isNative()) {
                    const trustline = findTrustline(destinationAccount, asset);
                    if (!trustline) {
                        throw new StellarPayoutError('destination_no_trustline', `no trustline for ${asset.getCode()}:${asset.getIssuer()}`);
                    }
                    if (toStroops(trustline.limit) - toStroops(trustline.balance) < toStroops(recipient.amount)) {
                        throw new StellarPayoutError('destination_trustline_full', 'trustline limit would be exceeded');
                    }
                }

                return Operation.payment({ destination, asset, amount: recipient.amount });
            } catch (error) {
                const code = error instanceof StellarPayoutError ? error.code : 'validation_failed';
                const message = error instanceof Error ? error.message : String(error);
                problems.push({ address: recipient.address, code, message });
                return null;
            }
        }));

        if (problems.length > 0) {
            throw new StellarPayoutError(
                'invalid_recipients',
                `batch rejected, ${problems.length} of ${recipients.length} recipients failed pre-flight: ${JSON.stringify(problems)}`
            );
        }

        return operations as xdr.Operation[];
    }

    /**
     * Log successful multi-send transaction
     */
    private async logSuccessfulMultiSend(currency: string, txId: string, requestId?: string): Promise<void> {
        const successMsg = notifierMessage.formatSuccessStellarMultiSendTransaction(currency, txId, requestId);
        const reqInfo = requestId ? `[${requestId}]` : '';
        logger.info(this.payway.toUpperCase(), `✅${reqInfo}[MULTISEND_CONFIRMED][HASH:${txId}]`);
        await modules.sendMessageToTelegram(successMsg);
    }

    /**
     * Log multi-send transaction error
     */
    private async logMultiSendError(currency: string, error: any, requestId?: string): Promise<void> {
        const described = describeStellarError(error);
        const errorMsg = notifierMessage.formatErrorStellarMultiSendTransaction(currency, described, requestId);
        const reqInfo = requestId ? `[${requestId}]` : '';
        logger.error(this.payway.toUpperCase(), `❌${reqInfo}[MULTISEND_ERROR][MSG:${described}]`);
        await modules.sendMessageToTelegram(errorMsg);
    }

    /**
     * Attributes on-chain per-operation failure codes back to recipient
     * addresses (used when the batch fails despite pre-flight, e.g. a
     * trustline was removed in the race window between check and submit).
     */
    private attributeFailures(error: any, recipients: Recipient[]): string | null {
        const codes = extractResultCodes(error);
        if (!codes?.operations?.length) {
            return null;
        }
        const failures = codes.operations
            .map((code, index) => ({ code, address: recipients[index]?.address }))
            .filter((entry) => entry.code !== 'op_success');
        return failures.length ? JSON.stringify(failures) : null;
    }

    /**
     * Sends up to 100 payments in a single atomic transaction.
     * @param recipients - Array of recipient addresses and decimal amounts.
     * @param currency - Display currency label (e.g. XLM, USDC).
     * @param options - Asset addressing, shared memo and request id.
     * @returns The hash of the confirmed transaction.
     */
    async multiSend(
        recipients: Recipient[],
        currency: string,
        options: StellarSendOptions = {}
    ): Promise<string> {
        try {
            if (!Array.isArray(recipients) || recipients.length === 0) {
                throw new StellarPayoutError('invalid_recipients', 'recipients must be a non-empty array');
            }
            if (recipients.length > Const.STELLAR_MAX_OPS_PER_TX) {
                throw new StellarPayoutError('too_many_recipients', `a Stellar transaction fits at most ${Const.STELLAR_MAX_OPS_PER_TX} operations, got ${recipients.length}`);
            }

            const asset = buildStellarAsset(options.assetCode, options.assetIssuer, options.contract);
            const memo = buildStellarMemo(options.memo, options.memoType);

            // Pre-flight first: collects ALL recipient problems in one round-trip
            // (amounts are validated per recipient inside prepareOperations)
            const operations = await this.prepareOperations(recipients, asset);

            const totalStroops = recipients.reduce((sum, recipient) => sum + toStroops(recipient.amount), 0n);
            await healSenderAccount(this.server, this.keypair, asset, totalStroops, this.payway);
            const response = await submitStellarTransaction(this.server, this.keypair, operations, memo);

            await this.logSuccessfulMultiSend(currency, response.hash, options.requestId);
            return response.hash;
        } catch (error) {
            await this.logMultiSendError(currency, error, options.requestId);

            if (error instanceof StellarPayoutError) {
                throw error;
            }
            const attributed = this.attributeFailures(error, recipients);
            if (attributed) {
                throw new StellarPayoutError('multi_send_failed', `atomic batch failed, nothing was paid out; failed operations: ${attributed}`);
            }
            if (extractResultCodes(error)) {
                throw new StellarPayoutError('horizon_error', describeStellarError(error));
            }
            throw error;
        }
    }
}
