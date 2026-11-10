/* External dependencies */
import { parseUnits } from 'viem';
import { TronWeb } from 'tronweb';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { modules } from '../utils/modules';
import { reportPayoutOutcome } from '../payouts/run';
import { notifierMessage } from '../utils/message-formatter';
import { sendTronTransactionVerified, waitForTronExecution } from '../utils/tron-broadcast';

/* Constants */
import { Const } from '../constants/const';
import { TronNormalizedPayload, TronLegacyPayoutRequestBody, TronCurrentPayoutData } from '../interfaces/payout.interface';

/**
 * Service class for handling Tron transactions
 */
export class TronPayoutService {
    private tronWeb: any;
    private decimalsCache: Record<string, number> = {};

    /**
     * Constructs a new instance of TronPayoutService.
     * @param payway - The payment method being used.
     * @param privateKey - The private key of the sender's wallet.
     */
    constructor(private payway: string, private privateKey: string) { }

    /**
     * Initializes TronWeb
     */
    async init() {
        this.tronWeb = new TronWeb({
            fullHost: Const.TRON_NILE,
            privateKey: this.privateKey
        });
    }

    /**
     * Get decimals from TRC20 token (cached so that don't have to yank the contract every time)
     * @param tokenContract - token address
     * @param fallbackDecimals - fallback if decimals() method is not implemented
     */
    async fetchDecimals(tokenContract: string, fallbackDecimals = 6): Promise<number> {
        if (this.decimalsCache[tokenContract] !== undefined) {
            return this.decimalsCache[tokenContract];
        }

        try {
            const contract = await this.tronWeb.contract().at(tokenContract);
            const decimals = await contract.decimals().call();
            const decimalsNumber = Number(decimals.toString());
            this.decimalsCache[tokenContract] = decimalsNumber;
            return decimalsNumber;
        } catch {
            // If method decimals() is not implemented
            this.decimalsCache[tokenContract] = fallbackDecimals;
            return fallbackDecimals;
        }
    }

    /**
     * Conversion of amount to base units taking into account token decimals. Same arithmetic as the EVM payouts
     * (viem parseUnits): digits past the token decimals are rounded instead of being glued onto the integer part,
     * which turned "1.1234567" TRX into 11.234567 TRX.
     */
    private convertToBaseUnit(amount: string, decimals: number): string {
        return parseUnits(amount, decimals).toString();
    }

    /**
     * Send native TRX transaction
     */
    private async sendNativeTransaction(payeeAddress: string, amount: string): Promise<string> {
        const sunAmount = this.convertToBaseUnit(amount, 6);
        // CN2-3910: verify the node accepted the broadcast - a rejected send still carries a
        // locally-computed txid, which must never be returned as if the tx was on-chain.
        return sendTronTransactionVerified(
            this.tronWeb,
            this.payway.toUpperCase(),
            () => this.tronWeb.trx.sendTransaction(payeeAddress, sunAmount)
        );
    }

    /**
     * Send TRC20 token transaction
     */
    private async sendTokenTransaction(
        payeeAddress: string,
        amount: string,
        contract: string
    ): Promise<string> {
        const decimals = await this.fetchDecimals(contract);
        const baseAmount = this.convertToBaseUnit(amount, decimals);
        const tokenContract = await this.tronWeb.contract().at(contract);

        // CN2-3910: same broadcast verification as for native sends
        return sendTronTransactionVerified(
            this.tronWeb,
            this.payway.toUpperCase(),
            () => tokenContract.transfer(payeeAddress, baseAmount).send({ feeLimit: Const.TRON_FEE_LIMIT })
        );
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
        const successMsg = notifierMessage.formatSuccessTronTransaction(amount, payeeAddress, currency, txId, requestId);
        const reqInfo = requestId ? `[${requestId}]` : '';
        logger.info(this.payway.toUpperCase(), `✅${reqInfo}[CONFIRMED][HASH:${txId}]`);
        await modules.sendMessageToTelegram(successMsg);
    }

    /**
     * Log transaction error
     */
    private async logTransactionError(currency: string, error: any, requestId?: string): Promise<void> {
        const errorMsg = notifierMessage.formatErrorTron(currency, error, requestId);
        const reqInfo = requestId ? `[${requestId}]` : '';
        logger.error(this.payway.toUpperCase(), `❌${reqInfo}[ERROR][MSG:${error?.message || String(error)}]`);
        await modules.sendMessageToTelegram(errorMsg);
    }

    /**
     * Send transactions (TRX or TRC20)
     * @param payee_address - The recipient's address.
     * @param amount - The amount to be transferred.
     * @param contract - The contract address of the token (if applicable).
     * @param currency - The currency being used (e.g., TRX, USDT).
     * @returns The transaction hash of the successful transaction.
     */
    async sendTransaction(
        payee_address: string,
        amount: string,
        contract: string | undefined,
        currency: string,
        requestId?: string,
        waitForReceipt: boolean = true
    ): Promise<string> {
        const network = this.payway.toUpperCase();
        const reqInfo = requestId ? `[${requestId}]` : '';
        try {
            const txId = contract
                ? await this.sendTokenTransaction(payee_address, amount, contract)
                : await this.sendNativeTransaction(payee_address, amount);

            if (!waitForReceipt) {
                logger.info(network, `📨${reqInfo}[SUBMITTED][HASH:${txId}]`);
                this.confirmInBackground(txId, amount, payee_address, currency, requestId);
                return txId;
            }

            // An accepted broadcast is not a payout yet: a TRC20 transfer can still revert or run out of energy
            await waitForTronExecution(this.tronWeb, network, txId);
            await this.logSuccessfulTransaction(amount, payee_address, currency, txId, requestId);
            return txId;
        } catch (error) {
            await this.logTransactionError(currency, error, requestId);
            throw error;
        }
    }

    /** wait_for_receipt: false answers after the broadcast; the execution is checked here and reported */
    private confirmInBackground(txId: string, amount: string, payeeAddress: string, currency: string, requestId?: string): void {
        void (async () => {
            try {
                await waitForTronExecution(this.tronWeb, this.payway.toUpperCase(), txId);
                await this.logSuccessfulTransaction(amount, payeeAddress, currency, txId, requestId);
                reportPayoutOutcome({ txId });
            } catch (error) {
                reportPayoutOutcome({ error, txId });
                await this.logTransactionError(currency, error, requestId);
            }
        })();
    }

    public static normalizeTronPayload(body: unknown): TronNormalizedPayload {
        if (!body || typeof body !== 'object') {
            throw new Error('Invalid request body');
        }

        const raw = body as Record<string, unknown>;
        const data = typeof raw.data === 'object' && raw.data !== null ? (raw.data as Record<string, unknown>) : raw;
        // Shared by both shapes: idempotency, completion callback and the receipt wait
        const options = {
            request_id: data.request_id,
            callback_url: data.callback_url,
            wait_for_receipt: data.wait_for_receipt
        };

        if ('to' in data && !('payee_address' in data)) {
            const legacy = data as TronLegacyPayoutRequestBody;
            const contract = legacy.contract ?? legacy.contract_id;

            return {
                payway: legacy.payway,
                private_key: legacy.private_key,
                currency: legacy.currency,
                payee_address: legacy.to,
                amount: legacy.amount,
                contract,
                isLegacy: true,
                ...options
            };
        }

        const current = data as TronCurrentPayoutData;

        return {
            payway: current.payway,
            private_key: current.private_key,
            currency: current.currency,
            payee_address: current.payee_address,
            amount: current.amount,
            contract: current.contract,
            isLegacy: false,
            ...options
        };
    }

    public static async resolveTronAmount(payload: TronNormalizedPayload, tronService: TronPayoutService): Promise<string> {
        if (!payload.isLegacy) {
            return payload.amount;
        }

        const trimmed = payload.amount.trim();
        if (trimmed === '' || trimmed.includes('.')) {
            return trimmed;
        }

        if (!payload.contract && payload.currency.toUpperCase() === 'TRX') {
            return TronPayoutService.baseUnitsToDecimal(trimmed, 6);
        }

        if (payload.contract) {
            const decimals = await tronService.fetchDecimals(payload.contract);
            return TronPayoutService.baseUnitsToDecimal(trimmed, decimals);
        }

        return trimmed;
    }

    public static baseUnitsToDecimal(amountBase: string, decimals: number): string {
        if (decimals <= 0) {
            return amountBase;
        }

        const negative = amountBase.startsWith('-');
        const digits = negative ? amountBase.slice(1) : amountBase;
        const normalizedDigits = digits.replace(/^0+/, '') || '0';
        const padded = normalizedDigits.padStart(decimals + 1, '0');
        const integerPart = padded.slice(0, -decimals);
        const fractionPart = padded.slice(-decimals);
        const fractionTrimmed = fractionPart.replace(/0+$/, '');
        const value = fractionTrimmed ? `${integerPart}.${fractionTrimmed}` : integerPart;

        return negative ? `-${value}` : value;
    }
}
