/* External dependencies */
import Web3 from 'web3';
import HDWalletProvider from '@truffle/hdwallet-provider';
import { PollingBlockTracker } from 'eth-block-tracker';

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
    private rpcUrl!: string;
    private senderAddress!: string;
    private decimalsCache: Record<string, number> = {};
    private blockTracker!: PollingBlockTracker;

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
        this.rpcUrl = await modules.getRpcUrl(this.payway);
        this.provider = new HDWalletProvider({
            privateKeys: [this.privateKey],
            providerOrUrl: this.rpcUrl
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
    }

    /**
     * Gets a dynamic multiplier for gas price based on network congestion.
     * @returns The multiplier to adjust the gas price.
     */
    private async getDynamicMultiplier(): Promise<number> {
        try {
            const gasPrice = Number(await this.web3.eth.getGasPrice());
            return gasPrice < 20e9 ? 1.2 : gasPrice < 50e9 ? 1.5 : 2.0;
        } catch (error) {
            console.error(`Error fetching dynamic multiplier: ${error}`);
            return 1.5;
        }
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
    async sendTransaction(payee_address: string, amount: string, contract: string, currency: string): Promise<string> {
        try {
            // Initialize block tracker
            this.blockTracker = new PollingBlockTracker({
                provider: this.web3.currentProvider as any,
                pollingInterval: 1000
            });

            // Tracking new blocks
            this.blockTracker.on('latest', (blockNumber: string) => {
                console.log(`New block detected from provider ${this.rpcUrl}: ${blockNumber}`);
            });

            this.blockTracker.on('error', (error: Error) => {
                console.error(`Block tracker error from provider ${this.rpcUrl}: ${error.message}`);
            });

            // Get current nonce and gas price, and increase gas price for faster inclusion
            const [actualNonce, gasPrice] = await Promise.all([
                this.web3.eth.getTransactionCount(this.senderAddress),
                this.web3.eth.getGasPrice()
            ]);

            // Increase gas price by the specified multiplier to speed up the transaction
            const increasedGasPrice = Math.ceil(Number(gasPrice) * await this.getDynamicMultiplier()).toString();

            let tx: any = {
                from: this.senderAddress,
                gasPrice: increasedGasPrice,
                nonce: actualNonce,
                timeout: 300000
            };

            if (!contract) {
                // Native token transfer
                const value = this.convertToBaseUnit(amount, 18);
                tx = { ...tx, to: payee_address, value };
            } else {
                // Standard ERC-20 token transfer
                const decimals = await this.fetchDecimals(contract);
                const amountInBase = this.convertToBaseUnit(amount, decimals);
                const tokenContract = new this.web3.eth.Contract(Const.ABI_CONTRACT, contract);
                const data = tokenContract.methods.transfer(payee_address, amountInBase).encodeABI();
                tx = { ...tx, to: contract, data };
            }

            // Estimate and set gas limit with buffer
            const estimatedGas = await this.web3.eth.estimateGas(tx);
            tx.gas = Math.min(estimatedGas + 100000);

            // Signed and send signed transaction
            const signedTx = await this.web3.eth.accounts.signTransaction(tx, this.privateKey);
            const transaction = await this.web3.eth.sendSignedTransaction(signedTx.rawTransaction!);

            // Log and notify about the successful transaction
            console.log(notifierMessage.formatSuccessEVMTransaction(this.payway, currency, transaction));
            await modules.sendMessageToTelegram(notifierMessage.formatSuccessEVMTransaction(this.payway, currency, transaction));

            // Stop tracking new blocks
            this.blockTracker.removeAllListeners();

            return transaction.transactionHash;
        } catch (error) {
            // Notify about the error
            await modules.sendMessageToTelegram(notifierMessage.formatErrorEVM(this.payway, currency, error));

            // Stop tracking new blocks
            this.blockTracker.removeAllListeners();

            throw error;
        }
    }
}
