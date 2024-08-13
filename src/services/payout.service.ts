/* External dependencies */
import Web3 from 'web3';
import HDWalletProvider from '@truffle/hdwallet-provider';

/* Internal dependencies */
import { modules } from '../utils/modules';
import { notifierMessage } from '../utils/message-formatter';

/* Constants */
import { Const } from '../constants/const';

/**
 * PayoutService class is responsible for handling EVM transactions.
 */
export class PayoutService {
    private provider: any;
    private web3: any;
    private senderAddress: string;

    /**
     * Constructor to initialize the service with payway and private key.
     * @param payway - The payway (blockchain network) to be used.
     * @param privateKey - The private key of the sender's account.
     */
    constructor(private payway: string, private privateKey: string) {
        this.provider = {} as HDWalletProvider;
        this.web3 = {} as Web3;
        this.senderAddress = '';
    }

    /**
     * Initializes the provider and web3 instance.
     * This method should be called before making any transactions.
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
     * Method allows access to the provider used by the service (need only fo test)
     *
     * @returns The provider instance used by the service.
     */
    getProvider() {
        return this.provider;
    }

    /**
     * Sends a transaction to the specified payee address with the given amount.
     * Supports both native token transfers and ERC-20 token transfers.
     *
     * @param payee_address - The recipient's address.
     * @param amount - The amount to be transferred.
     * @param contract - The contract address of the token (if applicable).
     * @param currency - The currency being used (e.g., ETH, BNB).
     * @returns The transaction hash of the successful transaction.
     */
    async sendTransaction(payee_address: string, amount: string, contract: string, currency: string) {
        try {
            // Get the current nonce for the sender's address
            const actualNonce = await this.web3.eth.getTransactionCount(this.senderAddress);

            // Get the gas price and multiply by 1.5 for faster transactions
            const gasPrice = Math.round((await this.web3.eth.getGasPrice()) * 1.5);

            let transaction;
            if (!contract) {
                // If no contract address is provided, send native tokens (e.g., ETH, BNB)
                transaction = await this.web3.eth.sendTransaction({
                    from: this.senderAddress,
                    to: payee_address,
                    value: this.web3.utils.toWei(amount, 'ether'),
                    gasPrice: gasPrice,
                    nonce: actualNonce,
                    timeout: 900000
                });
            } else {
                // If a contract address is provided, send ERC-20 tokens
                const assetContract = new this.web3.eth.Contract(Const.ABI_CONTRACT, contract);
                amount = Const.ETH_PAYWAY.includes(this.payway)
                    ? String(parseFloat(amount) * 1e6)
                    : contract === Const.BSC_CONTRACT.BEP20_BUSD
                        ? this.web3.utils.toWei(amount, 'ether')
                        : String(parseFloat(amount) * 1e6);

                // Estimate the gas required for the transaction
                const gasEstimation = await assetContract.methods.transfer(payee_address, amount).estimateGas({ from: this.senderAddress });

                // Send the ERC-20 token transaction
                transaction = await assetContract.methods.transfer(payee_address, amount).send({
                    from: this.senderAddress,
                    gas: gasEstimation,
                    gasPrice: gasPrice,
                    nonce: actualNonce,
                    timeout: 900000
                });
            }

            // Log and notify about the successful transaction
            console.log(notifierMessage.formatSuccessEVMTransaction(this.payway, currency, transaction));
            await modules.sendMessageToTelegram(notifierMessage.formatSuccessEVMTransaction(this.payway, currency, transaction));

            // Return the transaction hash
            return transaction.transactionHash;
        } catch (error) {
            // Log and notify about the error in the transaction
            console.log(notifierMessage.formatErrorEVM(this.payway, currency, {}));
            await modules.sendMessageToTelegram(notifierMessage.formatErrorEVM(this.payway, currency, {}));
            throw error;
        }
    }
}
