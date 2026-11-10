/* External dependencies */
import { parseUnits } from 'viem';
import { TronWeb } from 'tronweb';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { modules } from '../utils/modules';
import { reportPayoutOutcome } from '../payouts/run';
import { Recipient } from '../interfaces/payout.interface';
import { notifierMessage } from '../utils/message-formatter';
import { sendTronTransactionVerified, waitForTronExecution } from '../utils/tron-broadcast';

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
     * Conversion of amount to base units taking into account token decimals (viem parseUnits, as for EVM payouts)
     */
    private convertToBaseUnit(amount: string, decimals: number): string {
        return parseUnits(amount, decimals).toString();
    }

    /**
     * Decimals of the TRC20 token being sent. Amounts used to be scaled by 6 for every token, which only matched
     * 6-decimal tokens such as USDT; a token that does not answer decimals() still falls back to 6.
     */
    private async fetchTokenDecimals(token: string): Promise<number> {
        try {
            const contract = await this.tronWeb.contract().at(token);
            const decimals = Number((await contract.decimals().call()).toString());
            return Number.isInteger(decimals) && decimals >= 0 ? decimals : 6;
        } catch {
            logger.warn(this.payway.toUpperCase(), `⚠️[DECIMALS][TOKEN:${token}][FALLBACK:6]`);
            return 6;
        }
    }

    /**
     * Prepare recipient data for multi-send
     */
    private prepareMultiSendData(recipients: Recipient[], decimals: number): { addresses: string[]; amounts: string[] } {
        return {
            addresses: recipients.map(r => r.address),
            amounts: recipients.map(r => this.convertToBaseUnit(r.amount, decimals))
        };
    }

    /**
     * Send native TRX multi-transfer
     */
    private async sendNativeMultiTransfer(addresses: string[], amounts: string[]): Promise<string> {
        // CN2-3910: verify the node accepted the broadcast - a rejected send still carries a
        // locally-computed txid, which must never be returned as if the tx was on-chain.
        return sendTronTransactionVerified(
            this.tronWeb,
            this.payway.toUpperCase(),
            () => this.contractInstance.multiTransferTrx(addresses, amounts).send({ feeLimit: Const.TRON_FEE_LIMIT })
        );
    }

    /**
     * Send TRC20 token multi-transfer
     */
    private async sendTokenMultiTransfer(token: string, addresses: string[], amounts: string[]): Promise<string> {
        // CN2-3910: same broadcast verification as for the native multi-transfer
        return sendTronTransactionVerified(
            this.tronWeb,
            this.payway.toUpperCase(),
            () => this.contractInstance.multiTransferToken(token, addresses, amounts).send({ feeLimit: Const.TRON_FEE_LIMIT })
        );
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
        requestId?: string,
        waitForReceipt: boolean = true
    ): Promise<string> {
        const network = this.payway.toUpperCase();
        const reqInfo = requestId ? `[${requestId}]` : '';
        try {
            const decimals = token ? await this.fetchTokenDecimals(token) : 6;
            const { addresses, amounts } = this.prepareMultiSendData(recipients, decimals);
            const txId = token
                ? await this.sendTokenMultiTransfer(token, addresses, amounts)
                : await this.sendNativeMultiTransfer(addresses, amounts);

            if (!waitForReceipt) {
                logger.info(network, `📨${reqInfo}[MULTISEND_SUBMITTED][HASH:${txId}]`);
                this.confirmInBackground(txId, currency, requestId);
                return txId;
            }

            // An accepted broadcast is not a payout yet: the contract call can still revert or run out of energy
            await waitForTronExecution(this.tronWeb, network, txId);
            await this.logSuccessfulMultiSend(currency, txId, requestId);
            return txId;
        } catch (error) {
            await this.logMultiSendError(currency, error, requestId);
            throw error;
        }
    }

    /** wait_for_receipt: false answers after the broadcast; the execution is checked here and reported */
    private confirmInBackground(txId: string, currency: string, requestId?: string): void {
        void (async () => {
            try {
                await waitForTronExecution(this.tronWeb, this.payway.toUpperCase(), txId);
                await this.logSuccessfulMultiSend(currency, txId, requestId);
                reportPayoutOutcome({ txId });
            } catch (error) {
                reportPayoutOutcome({ error, txId });
                await this.logMultiSendError(currency, error, requestId);
            }
        })();
    }
}
