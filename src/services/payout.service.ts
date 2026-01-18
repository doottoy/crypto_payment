/* External dependencies */
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { createPublicClient, Address, Hex, encodeFunctionData, http, keccak256, parseUnits, type PublicClient } from 'viem';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { getChainForPayway, isEvmNetworkError } from '../utils/evm';
import { nonceAllocator, type NonceLease } from '../utils/nonce-allocator';
import { getEvmRpcUrlsForPayway, EVMTransactionLogger } from '../utils/modules';

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
        this.rpcUrls = getEvmRpcUrlsForPayway(this.payway);
        if (!this.rpcUrls.length) {
            throw new Error(`No RPC providers configured for payway = ${this.payway}`);
        }
    }

    /**
     * Converts a human-readable amount to base units using bigint math.
     */
    private convertToBaseUnit(amount: string, decimals: number): bigint {
        return parseUnits(amount, decimals);
    }

    /**
     * Fetch token decimals via RPC and cache the result.
     */
    private async fetchDecimals(
        client: PublicClient,
        tokenContract: Address,
        fallbackDecimals = 18
    ): Promise<number> {
        const key = tokenContract.toLowerCase();
        if (this.decimalsCache[key] !== undefined) {
            return this.decimalsCache[key];
        }
        try {
            const decVal = await client.readContract({
                address: tokenContract,
                abi: Const.MULTI_SEND_ABI_CONTRACT as any,
                functionName: 'decimals'
            });
            const dec = Number(decVal);
            if (Number.isFinite(dec)) {
                this.decimalsCache[key] = dec;
                return dec;
            }
            this.decimalsCache[key] = fallbackDecimals;
            return fallbackDecimals;
        } catch {
            this.decimalsCache[key] = fallbackDecimals;
            return fallbackDecimals;
        }
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
     * Implemented using bigint to avoid floating-point issues.
     */
    private async getDynamicGasPrice(client: PublicClient): Promise<bigint> {
        try {
            const gp = await client.getGasPrice();
            const GWEI = 10n ** 9n;
            if (gp < 20n * GWEI) {
                return (gp * 3n) / 2n;
            }
            if (gp < 50n * GWEI) {
                return gp * 2n;
            }
            return (gp * 21n) / 10n;
        } catch {
            // Fallback: arbitrary 2x multiplier on failure
            const gp = await client.getGasPrice();
            return gp * 2n;
        }
    }

    /**
     * Get basic transaction data (chainId, gasPrice) from client
     */
    private async getBasicTxData(client: PublicClient, account: PrivateKeyAccount): Promise<{
        chainId: number;
        gasPrice: bigint;
    }> {
        const [chainId, gasPrice] = await Promise.all([
            client.getChainId(),
            this.getDynamicGasPrice(client)
        ]);
        return { chainId, gasPrice };
    }

    /**
     * Prepare native token transfer transaction
     */
    private prepareNativeTransfer(payeeAddress: string, amount: string): { to: Address; value: bigint } {
        return {
            to: payeeAddress as Address,
            value: this.convertToBaseUnit(amount, 18)
        };
    }

    /**
     * Prepare ERC20 token transfer transaction
     */
    private async prepareTokenTransfer(
        client: PublicClient,
        payeeAddress: string,
        amount: string,
        contract: string
    ): Promise<{ to: Address; data: string }> {
        const tokenAddress = contract as Address;
        const decimals = await this.fetchDecimals(client, tokenAddress);
        const value = this.convertToBaseUnit(amount, decimals);
        const data = encodeFunctionData({
            abi: Const.ABI_CONTRACT,
            functionName: 'transfer',
            args: [payeeAddress as Address, value]
        });

        return { to: tokenAddress, data };
    }

    /**
     * Estimate and set gas limit for transaction
     */
    private async estimateAndSetGas(
        client: PublicClient,
        tx: any,
        accountAddress: Address,
        isTokenTransfer: boolean
    ): Promise<void> {
        const estimatedGas = await client.estimateGas({
            ...tx,
            account: accountAddress
        } as any);
        tx.gas = BigInt(this.clampGasLimit(Number(estimatedGas), isTokenTransfer));
    }

    /**
     * Builds and signs a transaction using the first healthy RPC.
     */
    private async prepareTxData(
        payeeAddress: string,
        amount: string,
        contract: string,
        currency: string
    ): Promise<{ rawTx: Hex; sender: Hex; nonceLease: NonceLease; chainId: number }> {
        let lastErr;
        const chain = getChainForPayway(this.payway);
        const account = privateKeyToAccount(
            (this.privateKey.startsWith('0x') ? this.privateKey : `0x${this.privateKey}`) as Hex
        );

        for (let i = 0; i < this.rpcUrls.length; i += 1) {
            const url = this.rpcUrls[i];
            const transport = http(url, { timeout: 10000 });
            const client = createPublicClient({ chain, transport });

            try {
                const { chainId, gasPrice } = await this.getBasicTxData(client, account);

                let tx: any = {
                    chainId,
                    gasPrice
                };

                // Prepare transaction data based on type
                if (!contract) {
                    Object.assign(tx, this.prepareNativeTransfer(payeeAddress, amount));
                } else {
                    Object.assign(tx, await this.prepareTokenTransfer(client, payeeAddress, amount, contract));
                }

                const isTokenTransfer = Boolean(contract);
                await this.estimateAndSetGas(client, tx, account.address, isTokenTransfer);

                const nonceLease = await nonceAllocator.reserveNonce(client, account.address, chainId);
                try {
                    tx.nonce = nonceLease.nonce;

                    const rawTx = await account.signTransaction(tx);
                    return { rawTx, sender: account.address, nonceLease, chainId };
                } catch (err) {
                    await nonceLease.release(false);
                    throw err;
                }
            } catch (err: any) {
                lastErr = err;
                logger.error('TX_PREP', `❌[PREPARE_FAILED][MSG:${err?.message || err?.toString?.() || String(err)}]`);
                if (!isEvmNetworkError(err)) {
                    throw err;
                }
                logger.warn('TX_PREP', '🔄[PREPARE_RETRY][NEXT_PROVIDER]');
            }
        }
        throw new Error(`All RPC providers failed during tx preparation: ${lastErr?.message || lastErr?.toString?.() || String(lastErr)}`
        );
    }

    /**
     * Log transaction preparation info
     */
    private logTransactionPreparation(rawTx: Hex, requestId?: string): void {
        const network = this.payway.toUpperCase();
        const reqInfo = requestId ? `[${requestId}]` : '';
        logger.info(network, `🧾${reqInfo}[PREPARED][RAW:${rawTx}]`);
        logger.info(network, `🧾${reqInfo}[PREPARED][HASH:${keccak256(rawTx)}]`);
    }

    /**
     * Send transaction via single RPC provider
     */
    private async sendViaProvider(
        client: PublicClient,
        rawTx: Hex,
        url: string,
        waitForReceipt: boolean
    ): Promise<{ hash: Hex; receipt?: any }> {
        const hash = await client.sendRawTransaction({ serializedTransaction: rawTx });
        if (waitForReceipt) {
            const receipt = await client.waitForTransactionReceipt({ hash });
            return { hash: receipt.transactionHash, receipt };
        }
        return { hash };
    }

    /**
     * Log successful transaction
     */
    private async logSuccessfulTransaction(
        result: { hash: string; receipt: any },
        sender: Hex,
        url: string,
        currency: string,
        duration: number,
        requestId?: string
    ): Promise<void> {
        await EVMTransactionLogger.logSuccess(
            this.payway,
            currency,
            result.hash,
            result.receipt,
            url,
            sender,
            duration,
            false,
            requestId
        );
    }

    /**
     * Log transaction error
     */
    private async logTransactionError(
        error: any,
        url: string,
        currency: string,
        duration: number,
        requestId?: string
    ): Promise<void> {
        await EVMTransactionLogger.logError(
            this.payway,
            currency,
            error,
            url,
            duration,
            false,
            requestId
        );
    }

    private logTransactionSubmitted(hash: string, url: string, requestId?: string): void {
        const network = this.payway.toUpperCase();
        const reqInfo = requestId ? `[${requestId}]` : '';
        logger.info(network, `📨${reqInfo}[SUBMITTED][${url}][HASH:${hash}]`);
    }

    private waitForReceiptInBackground(
        client: PublicClient,
        hash: Hex,
        sender: Hex,
        url: string,
        currency: string,
        start: number,
        chainId: number,
        requestId?: string
    ): void {
        void (async () => {
            try {
                const receipt = await client.waitForTransactionReceipt({ hash });
                const duration = Date.now() - start;
                await this.logSuccessfulTransaction(
                    { hash: receipt.transactionHash, receipt },
                    sender,
                    url,
                    currency,
                    duration,
                    requestId
                );
            } catch (error) {
                const duration = Date.now() - start;
                await this.logTransactionError(error, url, currency, duration, requestId);
                const reqInfo = requestId ? `[${requestId}]` : '';
                logger.warn(this.payway.toUpperCase(), `⚠️${reqInfo}[RECEIPT_WAIT_FAILED][ACTION:nonce_resync]`);
                await nonceAllocator.markResync(sender, chainId);
            }
        })();
    }

    /**
     * Attempts to send a transaction, iterating over rpcUrls until one succeeds.
     * @returns the transaction hash
     */
    async sendTransaction(
        payeeAddress: string,
        amount: string,
        contract: string,
        currency: string,
        waitForReceipt: boolean = true,
        requestId?: string
    ): Promise<string> {
        let lastErr: any;
        const network = this.payway.toUpperCase();
        const { rawTx, sender, nonceLease, chainId } = await this.prepareTxData(payeeAddress, amount, contract, currency);

        this.logTransactionPreparation(rawTx, requestId);

        let success = false;
        try {
            for (let i = 0; i < this.rpcUrls.length; i += 1) {
                const url = this.rpcUrls[i];
                const client = createPublicClient({
                    transport: http(url, { timeout: 10000 })
                });

                const reqInfo = requestId ? `[${requestId}]` : '';
                logger.info(network, `🔄${reqInfo}[TRY][${url}]`);
                const start = Date.now();

                try {
                    const result = await this.sendViaProvider(client, rawTx, url, waitForReceipt);
                    const duration = Date.now() - start;
                    if (waitForReceipt) {
                        await this.logSuccessfulTransaction(
                            { hash: result.hash, receipt: result.receipt as any },
                            sender,
                            url,
                            currency,
                            duration,
                            requestId
                        );
                    } else {
                        this.logTransactionSubmitted(result.hash, url, requestId);
                        this.waitForReceiptInBackground(client, result.hash, sender, url, currency, start, chainId, requestId);
                    }

                    success = true;
                    return result.hash;
                } catch (err: any) {
                    const duration = Date.now() - start;
                    lastErr = err;

                    await this.logTransactionError(err, url, currency, duration, requestId);

                    if (!isEvmNetworkError(err)) {
                        throw err;
                    }

                    logger.warn(network, `🔄${reqInfo}[RETRY][NEXT_PROVIDER][RAW:${keccak256(rawTx)}]`);
                }
            }

            throw new Error(`All RPC providers failed for payway = ${this.payway}: ${lastErr?.message || lastErr?.toString?.() || String(lastErr)}`
            );
        } finally {
            await nonceLease.release(success);
        }
    }
}
