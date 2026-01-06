/* External dependencies */
import Web3 from 'web3';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { modules } from '../utils/modules';
import { notifierMessage } from '../utils/message-formatter';

/* Constants */
import { Const } from '../constants/const';

/**
 * Service class for handling EVM transactions with dynamic gas calculation
 * and automatic fail-over between multiple RPC providers.
 */
export class PayoutService {
    private rpcUrls!: string[];
    private decimalsCache: Record<string, number> = {};

    /**
     * Constructs a new instance of PayoutService.
     * @param payway – the payment method
     * @param privateKey – the sender’s private key
     */
    constructor(private payway: string, private privateKey: string) {}

    /**
     * Initializes the list of RPC URLs for this payway.
     * Must be called before sendTransaction().
     */
    async init() {
        this.rpcUrls = modules.getEvmRpcUrlsForPayway(this.payway);
        if (!this.rpcUrls.length) {
            throw new Error(`No RPC providers configured for payway = ${this.payway}`);
        }
    }

    /**
     * Determines whether an error is network-related (DNS, timeout, connection).
     */
    private isNetworkError(err: any): boolean {
        const msg = (
            err?.message ||
            err?.data?.message ||
            err?.toString?.() ||
            ''
        ).toLowerCase();
        return Const.NETWORK_ERROR_PATTERNS.some(sub => msg.includes(sub));
    }

    /**
     * Fetches token decimals via RPC and caches the result.
     */
    private async fetchDecimals(
        web3: Web3,
        tokenContract: string,
        fallbackDecimals = 18
    ): Promise<number> {
        if (this.decimalsCache[tokenContract] !== undefined) {
            return this.decimalsCache[tokenContract];
        }
        try {
            const contract = new web3.eth.Contract(Const.MULTI_SEND_ABI_CONTRACT, tokenContract);
            const decStr: string = await contract.methods.decimals().call();
            const dec = Number(decStr);
            this.decimalsCache[tokenContract] = dec;
            return dec;
        } catch {
            this.decimalsCache[tokenContract] = fallbackDecimals;
            return fallbackDecimals;
        }
    }

    /**
     * Converts a human-readable amount to base units (wei, gwei, etc.).
     */
    private convertToBaseUnit(
        web3: Web3,
        amount: string,
        decimals: number
    ): string {
        const unit = Const.DECIMALS[decimals];
        if (!unit) throw new Error(`Unsupported token decimals: ${decimals}`);
        return web3.utils.toWei(amount, unit as any);
    }

    private clampGasLimit(estimated: number, isTokenTransfer: boolean): number {
        const withBuffer = Math.ceil(estimated * 1.2) + 5000;

        const MAX_TOKEN = 120000;
        const MAX_NATIVE = 80000;

        const cap = isTokenTransfer ? MAX_TOKEN : MAX_NATIVE;
        const MIN = isTokenTransfer ? 60000 : 21000;

        return Math.max(MIN, Math.min(withBuffer, cap));
    }

    /**
     * Picks a gas-price multiplier based on current network congestion.
     */
    private async getDynamicMultiplier(web3: Web3): Promise<number> {
        try {
            const gp = Number(await web3.eth.getGasPrice());
            if (gp < 20e9) return 1.5;
            if (gp < 50e9) return 2.0;
            return 2.1;
        } catch {
            return 2;
        }
    }

    /**
     * Tries to prepare transaction data (nonce, gas, etc.) on all RPCs, returns first valid result.
     */
    private async prepareTxData(
        payeeAddress: string,
        amount: string,
        contract: string,
        currency: string
    ): Promise<{ tx: any; web3: Web3; sender: string }> {
        let lastErr;
        for (let i = 0; i < this.rpcUrls.length; i += 1) {
            const url = this.rpcUrls[i];
            const web3 = new Web3(
                new Web3.providers.HttpProvider(url, { timeout: 10_000 })
            );
            try {
                web3.eth.accounts.wallet.clear();
                web3.eth.accounts.wallet.add(this.privateKey);
                const sender = web3.eth.accounts.wallet[0].address;

                const [nonce, gasPrice] = await Promise.all([
                    web3.eth.getTransactionCount(sender),
                    web3.eth.getGasPrice()
                ]);
                const multiplier = await this.getDynamicMultiplier(web3);
                const increasedGasPrice = Math.ceil(Number(gasPrice) * multiplier).toString();

                let tx: any = {
                    from: sender,
                    nonce,
                    gasPrice: increasedGasPrice
                };

                if (!contract) {
                    const value = this.convertToBaseUnit(web3, amount, 18);
                    tx = { ...tx, to: payeeAddress, value };
                } else {
                    const decimals = await this.fetchDecimals(web3, contract);
                    const value = this.convertToBaseUnit(web3, amount, decimals);
                    const tokenC = new web3.eth.Contract(Const.ABI_CONTRACT, contract);
                    const data = tokenC.methods.transfer(payeeAddress, value).encodeABI();
                    tx = { ...tx, to: contract, data };
                }

                const estimatedGas: number = await web3.eth.estimateGas(tx);
                const isTokenTransfer = Boolean(contract);
                tx.gas = this.clampGasLimit(estimatedGas, isTokenTransfer);

                return { tx, web3, sender };
            } catch (err: any) {
                lastErr = err;
                logger.error('TX_PREP', `❌  Failed to prepare tx: ${err?.message || err?.toString?.() || String(err)}`);
                if (!this.isNetworkError(err)) {
                    throw err;
                }
                logger.warn('TX_PREP', `⚠️ Retrying tx preparation with next provider`);
            }
        }
        throw new Error(`All RPC providers failed during tx preparation: ${lastErr?.message || lastErr?.toString?.() || String(lastErr)}`
        );
    }

    /**
     * Attempts to send a transaction, iterating over rpcUrls until one succeeds.
     * @returns the transaction hash
     */
    async sendTransaction(
        payeeAddress: string,
        amount: string,
        contract: string,
        currency: string
    ): Promise<string> {
        let lastErr: any;
        const network = this.payway.toUpperCase();

        const { tx, web3, sender } = await this.prepareTxData(
            payeeAddress,
            amount,
            contract,
            currency
        );

        const signed = await web3.eth.accounts.signTransaction(tx, this.privateKey);
        const rawTx = signed.rawTransaction!;

        logger.info(network, `✍️ Transaction RawTx ${rawTx}`);
        logger.info(network, `📝 Transaction hash: ${Web3.utils.keccak256(rawTx)}`);

        for (let i = 0; i < this.rpcUrls.length; i += 1) {
            const url = this.rpcUrls[i];
            const web3Send = new Web3(
                new Web3.providers.HttpProvider(url, { timeout: 10000 })
            );

            logger.info(network, `🔄 Trying provider [${url}]`);

            const start = Date.now();

            try {
                const receipt = await web3Send.eth.sendSignedTransaction(rawTx);

                const duration = Date.now() - start;
                const successMsg = notifierMessage.formatSuccessEVMTransaction(
                    this.payway,
                    currency,
                    receipt
                );

                logger.info(network, `✅  Success via [${url}] in ${duration}ms — txHash = ${receipt.transactionHash}`);
                logger.info(network, `✅  ${successMsg}`);
                await modules.sendMessageToTelegram(successMsg);

                return receipt.transactionHash;
            } catch (err: any) {
                const duration = Date.now() - start;
                lastErr = err;

                const errorMsg = notifierMessage.formatErrorEVM(
                    this.payway,
                    currency,
                    lastErr
                );
                await modules.sendMessageToTelegram(errorMsg);

                logger.error(network, `❌  [${url}] failed in ${duration}ms — ${err?.message || err?.toString?.() || String(err)}`);

                if (!this.isNetworkError(err)) {
                    throw err;
                }

                logger.warn(network, `⚠️ Retrying with next provider — re-sending the same rawTx (hash: ${Web3.utils.keccak256(rawTx)})`);
            }
        }

        throw new Error(`All RPC providers failed for payway = ${this.payway}: ${lastErr?.message || lastErr?.toString?.() || String(lastErr)}`
        );
    }
}
