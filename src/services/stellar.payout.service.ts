/* External dependencies */
import { Asset, Horizon, Keypair, Operation, xdr } from '@stellar/stellar-sdk';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { modules } from '../utils/modules';
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
 * Service class for handling Stellar payouts (native XLM and issued assets).
 *
 * Stellar specifics vs the EVM services:
 *  - a destination must EXIST on the ledger; for native XLM a missing
 *    destination is auto-created via a createAccount operation (>= 1 XLM);
 *  - an issued asset can only be received over an open trustline, so the
 *    destination is pre-flight checked to avoid burning a fee on op_no_trust;
 *  - one ledger close (~5s) is final — there is no receipt polling.
 */
export class StellarPayoutService {
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
     * Pre-flight checks of the destination and preparation of the payment
     * operation. Returns a createAccount operation instead of a payment when
     * a native-XLM destination does not exist yet.
     */
    private async prepareOperation(payeeAddress: string, amount: string, asset: Asset): Promise<xdr.Operation> {
        const { destination, baseAccountId } = resolveStellarDestination(payeeAddress);
        const destinationAccount = await loadAccountOrNull(this.server, baseAccountId);

        if (!destinationAccount) {
            if (!asset.isNative()) {
                throw new StellarPayoutError(
                    'destination_account_not_found',
                    `destination ${baseAccountId} does not exist on the ledger; an issued asset cannot be sent to an unfunded account`
                );
            }

            if (toStroops(amount) < toStroops(Const.STELLAR_MIN_CREATE_ACCOUNT_XLM)) {
                throw new StellarPayoutError(
                    'destination_account_not_found',
                    `destination ${baseAccountId} does not exist; auto-creation requires at least ${Const.STELLAR_MIN_CREATE_ACCOUNT_XLM} XLM (account reserve)`
                );
            }

            logger.warn(this.payway.toUpperCase(), `destination ${baseAccountId} not found — using createAccount instead of payment`);
            return Operation.createAccount({ destination: baseAccountId, startingBalance: amount });
        }

        if (!asset.isNative()) {
            const trustline = findTrustline(destinationAccount, asset);
            if (!trustline) {
                throw new StellarPayoutError(
                    'destination_no_trustline',
                    `destination ${baseAccountId} has no trustline for ${asset.getCode()}:${asset.getIssuer()}`
                );
            }
            if (toStroops(trustline.limit) - toStroops(trustline.balance) < toStroops(amount)) {
                throw new StellarPayoutError(
                    'destination_trustline_full',
                    `destination trustline limit for ${asset.getCode()} would be exceeded by this payment`
                );
            }
        }

        return Operation.payment({ destination, asset, amount });
    }

    /**
     * Log successful transaction
     */
    private async logSuccessfulTransaction(
        amount: string,
        payeeAddress: string,
        currency: string,
        txId: string,
        requestId?: string
    ): Promise<void> {
        const successMsg = notifierMessage.formatSuccessStellarTransaction(amount, this.keypair.publicKey(), currency, txId, requestId);
        const reqInfo = requestId ? `[${requestId}]` : '';
        logger.info(this.payway.toUpperCase(), `✅${reqInfo}[CONFIRMED][HASH:${txId}]`);
        await modules.sendMessageToTelegram(successMsg);
    }

    /**
     * Log transaction error
     */
    private async logTransactionError(currency: string, error: any, requestId?: string): Promise<void> {
        const described = describeStellarError(error);
        const errorMsg = notifierMessage.formatErrorStellar(currency, described, requestId);
        const reqInfo = requestId ? `[${requestId}]` : '';
        logger.error(this.payway.toUpperCase(), `❌${reqInfo}[ERROR][MSG:${described}]`);
        await modules.sendMessageToTelegram(errorMsg);
    }

    /**
     * Sends a payout (XLM or an issued asset such as USDC).
     * @param payee_address - The recipient's address (G... or muxed M...).
     * @param amount - Decimal amount string (max 7 decimal places).
     * @param currency - Display currency label (e.g. XLM, USDC).
     * @param options - Asset addressing, memo and request id.
     * @returns The hash of the confirmed transaction (finality is immediate).
     */
    async sendTransaction(
        payee_address: string,
        amount: string,
        currency: string,
        options: StellarSendOptions = {}
    ): Promise<string> {
        try {
            validateStellarAmount(amount);
            const asset = buildStellarAsset(options.assetCode, options.assetIssuer, options.contract);
            const memo = buildStellarMemo(options.memo, options.memoType);

            await healSenderAccount(this.server, this.keypair, asset, toStroops(amount), this.payway);

            const operation = await this.prepareOperation(payee_address, amount, asset);
            const response = await submitStellarTransaction(this.server, this.keypair, [operation], memo);

            await this.logSuccessfulTransaction(amount, payee_address, currency, response.hash, options.requestId);
            return response.hash;
        } catch (error) {
            await this.logTransactionError(currency, error, options.requestId);

            if (error instanceof StellarPayoutError) {
                throw error;
            }
            const codes = extractResultCodes(error);
            if (codes) {
                throw new StellarPayoutError('horizon_error', describeStellarError(error));
            }
            throw error;
        }
    }
}
