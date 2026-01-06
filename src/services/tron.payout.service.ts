/* External dependencies */
import { TronWeb } from 'tronweb';

/* Internal dependencies */
import { modules } from '../utils/modules';
import { notifierMessage } from '../utils/message-formatter';

/* Constants */
import { Const } from '../constants/const';

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
    constructor(private payway: string, private privateKey: string) {}

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
        return await this.tronWeb.trx.sendTransaction(payeeAddress, sunAmount);
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

        return await tokenContract.transfer(payeeAddress, baseAmount).send({ feeLimit: Const.TRON_FEE_LIMIT });
    }

    /**
     * Log successful transaction
     */
    private async logSuccessfulTransaction(
        amount: string,
        payeeAddress: string,
        currency: string,
        txId: string
    ): Promise<void> {
        const successMsg = notifierMessage.formatSuccessTronTransaction(amount, payeeAddress, currency, txId);
        console.log(successMsg);
        await modules.sendMessageToTelegram(successMsg);
    }

    /**
     * Log transaction error
     */
    private async logTransactionError(currency: string, error: any): Promise<void> {
        const errorMsg = notifierMessage.formatErrorTron(currency, error);
        console.error(errorMsg);
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
    async sendTransaction(payee_address: string, amount: string, contract: string, currency: string): Promise<string> {
        try {
            const txId = contract
                ? await this.sendTokenTransaction(payee_address, amount, contract)
                : await this.sendNativeTransaction(payee_address, amount);

            await this.logSuccessfulTransaction(amount, payee_address, currency, txId);
            return txId;
        } catch (error) {
            await this.logTransactionError(currency, error);
            throw error;
        }
    }
}
