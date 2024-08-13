/* External dependencies */
import Web3 from 'web3';
import HDWalletProvider from '@truffle/hdwallet-provider';

/* Internal dependencies */
import { modules } from '../utils/modules';
import { notifierMessage } from '../utils/message-formatter';

/* Constants */
import { Const } from '../constants/const';

/* Types */
type Recipient = {
    address: string;
    amount: string;
};

/**
 * Service class for performing multi-send transactions on the blockchain.
 */
export class MultiPayoutService {
    private provider: any;
    private web3: any;
    private senderAddress: string;

    /**
     * Constructs a new instance of MultiPayoutService.
     * @param payway - The payment method being used.
     * @param privateKey - The private key of the sender's wallet.
     */
    constructor(private payway: string, private privateKey: string) {
        this.provider = {} as HDWalletProvider;
        this.web3 = {} as Web3;
        this.senderAddress = '';
    }

    /**
     * Initializes the provider and web3 instance.
     * Should be called before sending transactions.
     */
    async init() {
        this.provider = new HDWalletProvider({
            privateKeys: [this.privateKey],
            providerOrUrl: await modules.getRpcUrl(this.payway)
        });

        this.web3 = new Web3(this.provider);
        this.senderAddress = this.provider.getAddresses()[0];
    }

    /**
     * Method allows access to the provider used by the service.
     *
     * @returns The provider instance used by the service.
     */
    getProvider() {
        return this.provider;
    }

    /**
     * Sends multiple transactions in a single transaction.
     * @param recipients - Array of recipient addresses and amounts to be sent.
     * @param multiSendContract - The contract address used for multi-send.
     * @param currency - The currency being sent.
     * @returns The transaction hash.
     */
    async multiSend(recipients: Recipient[], multiSendContract: string, currency: string) {
        try {
            // Get the current nonce for the sender's address
            const actualNonce = await this.web3.eth.getTransactionCount(this.senderAddress);
            // Get the current gas price
            const gasPrice = await this.web3.eth.getGasPrice();
            // Set the gas limit for the transaction
            const gasLimit = Const.MULTI_SEND_GAS_LIMIT;

            // Prepare the recipient data with addresses and amounts in Wei
            const multiSendData = recipients.map(recipient => ({
                address: recipient.address,
                amount: this.web3.utils.toWei(recipient.amount, 'ether')
            }));

            // Initialize the multi-send contract instance
            const contract = new this.web3.eth.Contract(Const.MULTI_SEND_ABI_CONTRACT, multiSendContract);
            // Encode the multi-send transaction data
            const txData = contract.methods.multiSend(
                multiSendData.map(data => data.address),
                multiSendData.map(data => data.amount)
            ).encodeABI();

            // Sign the transaction with the private key
            const signedTx = await this.web3.eth.accounts.signTransaction({
                to: multiSendContract,
                data: txData,
                gas: Const.ARBITRUM_PAYWAY.includes(this.payway) ? gasLimit * 2 : gasLimit, // Adjust gas limit for Arbitrum payway
                gasPrice: gasPrice,
                nonce: actualNonce
            }, this.privateKey);

            // Send the signed transaction
            const transaction = await this.web3.eth.sendSignedTransaction(signedTx.rawTransaction);

            // Log and notify about the successful transaction
            console.log(notifierMessage.formatSuccessMultiSend(this.payway, currency, transaction));
            await modules.sendMessageToTelegram(notifierMessage.formatSuccessMultiSend(this.payway, currency, transaction));

            // Return the transaction hash
            return transaction.transactionHash;
        } catch (error) {
            // Log and notify about the error in the transaction
            console.log(notifierMessage.formatErrorMultiSend(this.payway, currency, {}));
            await modules.sendMessageToTelegram(notifierMessage.formatErrorMultiSend(this.payway, currency, {}));
            throw error;
        }
    }
}
