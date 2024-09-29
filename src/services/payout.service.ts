/* External dependencies */
import Web3 from 'web3';
import HDWalletProvider from '@truffle/hdwallet-provider';

/* Internal dependencies */
import { modules } from '../utils/modules';
import { notifierMessage } from '../utils/message-formatter';

/* Constants */
import { Const } from '../constants/const';

/**
 * Service class for handling EVM transactions with dynamic gas calculation and amount conversion based on decimals
 */
export class PayoutService {
    private provider!: HDWalletProvider;
    private web3!: Web3;
    private senderAddress!: string;
    private decimalsCache: Record<string, number> = {};

    /**
    * Constructs a new instance of PayoutService.
     * @param payway - The payment method being used.
     * @param privateKey - The private key of the sender's wallet.
    */
    constructor(private payway: string, private privateKey: string) {}

    /**
     * Initializes the provider and web3 instance.
     * Should be called before sending transactions.
    */
    async init() {
        const rpcUrl = await modules.getRpcUrl(this.payway);
        this.provider = new HDWalletProvider({
            privateKeys: [this.privateKey],
            providerOrUrl: rpcUrl
        });
        this.web3 = new Web3(this.provider as any);
        this.senderAddress = this.provider.getAddress(0);
    }

    /**
     * Fetches the decimals from the token contract.
     * Caches the decimals to avoid redundant network calls.
     * @param tokenContract - The address of the token contract.
     * @param fallbackDecimals - The fallback decimals if the contract does not implement decimals().
     * @returns The number of decimals for the token.
    */
    async fetchDecimals(tokenContract: string, fallbackDecimals = 18): Promise<number> {
        if (this.decimalsCache[tokenContract] !== undefined) {
            return this.decimalsCache[tokenContract];
        }

        try {
            const contract = new this.web3.eth.Contract(Const.MULTI_SEND_ABI_CONTRACT, tokenContract);
            const decimals: string = await contract.methods.decimals().call();
            const decimalsNumber = Number(decimals);
            this.decimalsCache[tokenContract] = decimalsNumber;
            return decimalsNumber;
        } catch {
            return this.decimalsCache[tokenContract] = fallbackDecimals;
        }
    }

    /**
    * Converts the amount to base units based on the token's decimals.
     * @param amount - The amount to convert.
     * @param decimals - The number of decimals for the token.
     * @returns The amount in base units as a string.
    */
    private convertToBaseUnit(amount: string, decimals: number): string {
        const unit = Const.DECIMALS[decimals];
        if (!unit) throw new Error(`Unsupported token decimals: ${decimals}`);
        return this.web3.utils.toWei(amount, unit as any);
    }

    /**
     * Method allows access to the provider used by the service (need only for test).
     *
     * @returns The provider instance used by the service.
    */
    getProvider(): HDWalletProvider {
        return this.provider;

        // // Standard ERC-20 token transfer
        // const decimals = await this.fetchDecimals(contract);
        // const amountInBase = this.convertToBaseUnit(amount, decimals);
        // const tokenContract = new this.web3.eth.Contract(Const.ABI_CONTRACT, contract);
        // const data = tokenContract.methods.transfer(payee_address, amountInBase).encodeABI();
        // tx = { ...tx, to: contract, data };
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
            // Get current nonce and gas price
            const [actualNonce, gasPrice] = await Promise.all([
                this.web3.eth.getTransactionCount(this.senderAddress),
                this.web3.eth.getGasPrice()
            ]);

            let transaction;
            if (!contract) {
                // If no contract address is provided, send native tokens (e.g., ETH, BNB)
                transaction = await this.web3.eth.sendTransaction({
                    from: this.senderAddress,
                    to: payee_address,
                    value: this.web3.utils.toWei(amount, 'ether'),
                    gasPrice: Number(gasPrice) * 1.7,
                    nonce: actualNonce
                });
            } else {
                // If a contract address is provided, send standard-20 tokens
                const assetContract = new this.web3.eth.Contract(Const.ABI_CONTRACT, contract);

                const decimals = await this.fetchDecimals(contract);
                amount = this.convertToBaseUnit(amount, decimals)

                // Estimate the gas required for the transaction
                const gasEstimation = await assetContract.methods.transfer(payee_address, amount).estimateGas({ from: this.senderAddress });

                // Send the standard-20 token transaction
                transaction = await assetContract.methods.transfer(payee_address, amount).send({
                    from: this.senderAddress,
                    gas: gasEstimation,
                    gasPrice: Number(gasPrice) * 1.7,
                    nonce: actualNonce,
                    timeout: 300000
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
