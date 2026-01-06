/* External dependencies */
import { TronWeb } from 'tronweb';

/* Internal dependencies */
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
     * Sends multiple transactions in a single transaction.
     * @param token — (optional) address of TRC20 token, if empty send TRX.
     * @param recipients — Array of recipient addresses and amounts to be sent.
     * @param currency — The token contract address being sent.
     */
    async multiSend(token: string | undefined, recipients: Recipient[], currency: string): Promise<string> {
        try {
            let txId: string;

            // Prepare recipient data with proper scaling
            const addresses = recipients.map(r => r.address);
            const amounts = recipients.map(r => this.convertToBaseUnit(r.amount, 6));

            if (!token) {
                // Call multiTransferTrx (addresses[], amounts[]) for send native token
                txId = await this.contractInstance
                    .multiTransferTrx(addresses, amounts)
                    .send({ feeLimit: Const.TRON_FEE_LIMIT });
            } else {
                // Call multiTransferToken(token, addresses[], amounts[]) for send trc20 token.
                txId = await this.contractInstance
                    .multiTransferToken(token, addresses, amounts)
                    .send({ feeLimit: Const.TRON_FEE_LIMIT });
            }

            // Log and notify about the successful transaction
            console.log(notifierMessage.formatSuccessTronMultiSendTransaction(currency, txId));
            await modules.sendMessageToTelegram(notifierMessage.formatSuccessTronMultiSendTransaction(currency, txId));

            return txId;
        } catch (error) {
            // Log and notify about the transaction error
            console.error(notifierMessage.formatErrorTronMultiSendTransaction(currency, JSON.stringify(error)));
            await modules.sendMessageToTelegram(notifierMessage.formatErrorTronMultiSendTransaction(currency, error));

            throw error;
        }
    }
}
