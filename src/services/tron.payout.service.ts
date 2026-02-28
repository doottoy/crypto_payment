/* External dependencies */
import { TronWeb } from 'tronweb';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { modules } from '../utils/modules';
import { notifierMessage } from '../utils/message-formatter';

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
     * Conversion of amount to base units taking into account token decimals
     */
    private convertToBaseUnit(amount: string, decimals: number): string {
        const [integerPart, fractionPart = ''] = amount.split('.');
        const fracPadded = fractionPart.padEnd(decimals, '0');
        return integerPart + fracPadded;
    }

    /**
     * Send native TRX transaction
     */
    private async sendNativeTransaction(payeeAddress: string, amount: string): Promise<string> {
        const sunAmount = this.convertToBaseUnit(amount, 6);
        const res = await this.tronWeb.trx.sendTransaction(payeeAddress, sunAmount);
        return this.extractTxId(res);
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

        const res = await tokenContract.transfer(payeeAddress, baseAmount).send({ feeLimit: Const.TRON_FEE_LIMIT });
        return this.extractTxId(res);
    }

    private extractTxId(result: any): string {
        if (typeof result === 'string') return result;
        if (result?.txid) return result.txid;
        if (result?.transaction?.txID) return result.transaction.txID;
        if (result?.transaction?.txId) return result.transaction.txId;
        return String(result);
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
        requestId?: string
    ): Promise<string> {
        try {
            const txId = contract
                ? await this.sendTokenTransaction(payee_address, amount, contract)
                : await this.sendNativeTransaction(payee_address, amount);

            await this.logSuccessfulTransaction(amount, payee_address, currency, txId, requestId);
            return txId;
        } catch (error) {
            await this.logTransactionError(currency, error, requestId);
            throw error;
        }
    }

    public static normalizeTronPayload(body: unknown): TronNormalizedPayload {
        if (!body || typeof body !== 'object') {
            throw new Error('Invalid request body');
        }

        const raw = body as Record<string, unknown>;
        const data = typeof raw.data === 'object' && raw.data !== null ? (raw.data as Record<string, unknown>) : raw;

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
                isLegacy: true
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
            isLegacy: false
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
