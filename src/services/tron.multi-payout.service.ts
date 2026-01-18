/* External dependencies */
import { TronWeb } from 'tronweb';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { modules } from '../utils/modules';
import { Recipient } from '../interfaces/payout.interface';
import { notifierMessage } from '../utils/message-formatter';

/* Constants */
import { Const } from '../constants/const';

/**
 * Service class for performing multi-send transactions on the Tron
 */
export class TronMultiPayoutService {
    private tronWeb!: any;
    private contractInstance: any;

    /**
     * @param payway - The payment method being used.
     * @param privateKey - The private key of the sender's wallet.
     */
    constructor(private payway: string, private privateKey: string) {}

    /**
     * Initializes the provider, tronWeb instance, and contract.
     * Should be called before sending transactions.
     * @param multiSendContractAddress - The address of the multiSend contract
     */
    async init(multiSendContractAddress: string) {
        this.tronWeb = new TronWeb({
            fullHost: Const.TRON_NILE,
            privateKey: this.privateKey
        });

        this.contractInstance = await this.tronWeb.contract().at(multiSendContractAddress);
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
     * Prepare recipient data for multi-send
     */
    private prepareMultiSendData(recipients: Recipient[]): { addresses: string[]; amounts: string[] } {
        return {
            addresses: recipients.map(r => r.address),
            amounts: recipients.map(r => this.convertToBaseUnit(r.amount, 6))
        };
    }

    /**
     * Send native TRX multi-transfer
     */
    private async sendNativeMultiTransfer(addresses: string[], amounts: string[]): Promise<string> {
        const res = await this.contractInstance
            .multiTransferTrx(addresses, amounts)
            .send({ feeLimit: Const.TRON_FEE_LIMIT });
        return this.extractTxId(res);
    }

    /**
     * Send TRC20 token multi-transfer
     */
    private async sendTokenMultiTransfer(token: string, addresses: string[], amounts: string[]): Promise<string> {
        const res = await this.contractInstance
            .multiTransferToken(token, addresses, amounts)
            .send({ feeLimit: Const.TRON_FEE_LIMIT });
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
     * Log successful multi-send transaction
     */
    private async logSuccessfulMultiSend(currency: string, txId: string, requestId?: string): Promise<void> {
        const successMsg = notifierMessage.formatSuccessTronMultiSendTransaction(currency, txId, requestId);
        const reqInfo = requestId ? `[${requestId}]` : '';
        logger.info(this.payway.toUpperCase(), `✅${reqInfo}[MULTISEND_CONFIRMED][HASH:${txId}]`);
        await modules.sendMessageToTelegram(successMsg);
    }

    /**
     * Log multi-send transaction error
     */
    private async logMultiSendError(currency: string, error: any, requestId?: string): Promise<void> {
        const errorMsg = notifierMessage.formatErrorTronMultiSendTransaction(currency, error, requestId);
        const reqInfo = requestId ? `[${requestId}]` : '';
        logger.error(this.payway.toUpperCase(), `❌${reqInfo}[MULTISEND_ERROR][MSG:${error?.message || String(error)}]`);
        await modules.sendMessageToTelegram(errorMsg);
    }

    /**
     * Sends multiple transactions in a single transaction.
     * @param token — (optional) address of TRC20 token, if empty send TRX.
     * @param recipients — Array of recipient addresses and amounts to be sent.
     * @param currency — The token contract address being sent.
     */
    async multiSend(
        token: string | undefined,
        recipients: Recipient[],
        currency: string,
        requestId?: string
    ): Promise<string> {
        try {
            const { addresses, amounts } = this.prepareMultiSendData(recipients);
            const txId = token
                ? await this.sendTokenMultiTransfer(token, addresses, amounts)
                : await this.sendNativeMultiTransfer(addresses, amounts);

            await this.logSuccessfulMultiSend(currency, txId, requestId);
            return txId;
        } catch (error) {
            await this.logMultiSendError(currency, error, requestId);
            throw error;
        }
    }
}
