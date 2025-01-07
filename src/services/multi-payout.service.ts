/* External dependencies */
import Web3 from 'web3';
import HDWalletProvider from '@truffle/hdwallet-provider';
import { Contract } from 'web3-eth-contract';

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
    private provider: HDWalletProvider;
    private web3: Web3;
    private senderAddress: string;
    private decimals: number;
    private decimalsCache: { [tokenAddress: string]: number } = {};
    private contract: Contract;

    /**
     * Constructs a new instance of MultiPayoutService.
     * @param payway - The payment method being used.
     * @param privateKey - The private key of the sender's wallet.
     */
    constructor(private payway: string, private privateKey: string) {
        this.provider = {} as HDWalletProvider;
        this.web3 = {} as Web3;
        this.senderAddress = '';
        this.decimals = Number();
        this.contract = {} as Contract;
    }

    /**
     * Initializes the provider, web3 instance, and contract.
     * Should be called before sending transactions.
     * @param multiSendContractAddress - The address of the multiSend contract (matches tokenContractAddress)
     */
    async init(multiSendContractAddress: string) {
        this.provider = new HDWalletProvider({
            privateKeys: [this.privateKey],
            providerOrUrl: await modules.getRpcUrl(this.payway)
        }) as unknown as HDWalletProvider;

        this.web3 = new Web3(this.provider as any);
        this.senderAddress = this.provider.getAddresses()[0];

        // Initialize the contract with the provided ABI and address
        this.contract = new this.web3.eth.Contract(Const.MULTI_SEND_ABI_CONTRACT, multiSendContractAddress);
    }

    /**
     * Fetches the decimals from the token contract.
     * @param tokenContract - The address of the token contract.
     * @param fallbackDecimals - The fallback decimals if the contract does not implement decimals().
     */
    async fetchDecimals(tokenContract: string, fallbackDecimals: number = 18): Promise<void> {
        if (this.decimalsCache[tokenContract] !== undefined) {
            this.decimals = this.decimalsCache[tokenContract];
            return;
        }

        try {
            const decimals: number = await this.contract.methods.decimals().call();
            this.decimals = decimals;
            this.decimalsCache[tokenContract] = decimals;
        } catch (error) {
            this.decimals = fallbackDecimals;
            this.decimalsCache[tokenContract] = fallbackDecimals;
        }
    }

    /**
     * Converts the amount to base units based on the token's decimals.
     * @param amount - The amount to convert.
     * @returns The amount in base units as a string.
     */
    private convertToBaseUnit(amount: string): string {
        const decimalsMap: { [key: number]: string } = Const.DECIMALS;
        const unit = decimalsMap[this.decimals];

        return this.web3.utils.toWei(amount, unit as any);
    }

    /**
     * Method allows access to the provider used by the service.
     *
     * @returns The provider instance used by the service.
     */
    getProvider(): HDWalletProvider {
        return this.provider;
    }

    /**
     * Sends multiple transactions in a single transaction.
     * @param recipients - Array of recipient addresses and amounts to be sent.
     * @param multiSendContract - The contract address used for multi-send (matches tokenContractAddress).
     * @param currency - The token contract address being sent.
     * @returns The transaction hash.
     */
    async multiSend(recipients: Recipient[], multiSendContract: string, currency: string): Promise<string> {
        try {
            // Get decimals for the token
            await this.fetchDecimals(currency);

            // Get current nonce and gas price
            const [actualNonce, gasPrice] = await Promise.all([
                this.web3.eth.getTransactionCount(this.senderAddress),
                this.web3.eth.getGasPrice()
            ]);

            // Prepare recipient data with proper scaling
            const multiSendData = recipients.map(recipient => ({
                address: recipient.address,
                amount: this.convertToBaseUnit(recipient.amount)
            }));

            // Encode transaction data for multi-send
            const txData = this.contract.methods.multiSend(
                multiSendData.map(data => data.address),
                multiSendData.map(data => data.amount)
            ).encodeABI();

            // Estimate gas for the transaction
            const estimatedGas: number = await this.contract.methods.multiSend(
                multiSendData.map(data => data.address),
                multiSendData.map(data => data.amount)
            ).estimateGas({ from: this.senderAddress, value: 0 });

            // Add buffer to gas estimate
            const finalGasLimit = Math.min(estimatedGas + 10000, Const.MULTI_SEND_GAS_LIMIT);

            // Sign the transaction
            const signedTx = await this.web3.eth.accounts.signTransaction({
                to: multiSendContract,
                data: txData,
                gas: finalGasLimit,
                gasPrice: gasPrice,
                nonce: actualNonce
            }, this.privateKey);

            // Send the signed transaction
            const transaction = await this.web3.eth.sendSignedTransaction(signedTx.rawTransaction!);

            // Log and notify about the successful transaction
            console.log(notifierMessage.formatSuccessMultiSend(this.payway, currency, transaction));
            await modules.sendMessageToTelegram(notifierMessage.formatSuccessMultiSend(this.payway, currency, transaction));

            // Return the transaction hash
            return transaction.transactionHash;
        } catch (error) {
            // Log and notify about the transaction error
            console.log(notifierMessage.formatErrorMultiSend(this.payway, currency, JSON.stringify(error)));
            await modules.sendMessageToTelegram(notifierMessage.formatErrorMultiSend(this.payway, currency, error));

            throw error;
        }
    }
}
