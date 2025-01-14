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
     * Send transactions (TRX or TRC20)
     * @param payee_address - The recipient's address.
     * @param amount - The amount to be transferred.
     * @param contract - The contract address of the token (if applicable).
     * @param currency - The currency being used (e.g., TRX, USDT).
     * @returns The transaction hash of the successful transaction.
     */
    async sendTransaction(payee_address: string, amount: string, contract: string, currency: string): Promise<string> {
        try {
            let txId: string;

            if (!contract) {
                // Native token transfer
                const sunAmount = this.convertToBaseUnit(amount, 6);
                const res = await this.tronWeb.trx.sendTransaction(payee_address, sunAmount);
                txId = res.txid;
            } else {
                // Standard TRC-20 token transfer
                const decimals = await this.fetchDecimals(contract);
                const baseAmount = this.convertToBaseUnit(amount, decimals);
                const tokenContract = await this.tronWeb.contract().at(contract);

                const res = await tokenContract.transfer(payee_address, baseAmount).send({ feeLimit: Const.TRON_FEE_LIMIT });
                txId = res;
            }

            // Log and notify about the successful transaction
            console.log(notifierMessage.formatSuccessTronTransaction(amount, payee_address, currency, txId));
            await modules.sendMessageToTelegram(notifierMessage.formatSuccessTronTransaction(amount, payee_address, currency, txId));

            return txId;
        } catch (error) {
            // Log and notify about the transaction error
            console.error(notifierMessage.formatErrorTron(currency, JSON.stringify(error)));
            await modules.sendMessageToTelegram(notifierMessage.formatErrorTron(currency, error));

            throw error;
        }
    }
}
