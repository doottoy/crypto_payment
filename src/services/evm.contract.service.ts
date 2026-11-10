/* External dependencies */
import { createPublicClient, http, keccak256, type Abi, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { nonceAllocator } from '../utils/nonce-allocator';
import { EvmNonceTakenError, isEvmNetworkError, isEvmProviderError } from '../utils/evm';

import { BaseEvmService } from './base.evm.service';

/**
 * Sends one EVM transaction (a contract call or a contract creation) and waits for its successful receipt.
 * Same safety rails as the batch payouts: nonce from the shared allocator, provider failover with send recovery,
 * fee bumps on replacement errors, a re-sign on a fresh nonce when another tx took ours, the nonce lease released on
 * every path. Unlike them, errors are rethrown as they are, so a revert still answers `tx_reverted`.
 */
export class EvmContractService extends BaseEvmService {
    async init(): Promise<void> {
        this.initBase();
    }

    get senderAddress(): Address {
        return this.account.address;
    }

    /**
     * Runs `action` on the first provider that answers it. A provider failing the request itself (HTTP error, timeout,
     * refusal) is skipped like in the payouts; a verdict on the call (a revert) is thrown at once.
     */
    private async onAnyProvider<T>(action: (client: PublicClient, url: string) => Promise<T>): Promise<T> {
        let lastError: any;
        for (const url of this.rpcUrls) {
            const client = createPublicClient({ chain: this.chain, transport: http(url, { timeout: 10000 }) }) as PublicClient;
            try {
                return await action(client, url);
            } catch (error: any) {
                lastError = error;
                if (!isEvmNetworkError(error) && !isEvmProviderError(error)) throw error;
                logger.warn(this.payway.toUpperCase(), `⚠️[PROVIDER_SKIPPED][${url}][MSG:${error?.shortMessage || error?.message || error}]`);
            }
        }
        throw new Error(`All RPC providers failed for payway = ${this.payway}: ${lastError?.shortMessage || lastError?.message || lastError}`);
    }

    async read<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
        return this.onAnyProvider(async (client) => (await client.readContract({ address, abi, functionName, args } as any)) as T);
    }

    async receiptOf(hash: Hex): Promise<TransactionReceipt> {
        return this.onAnyProvider((client) => client.getTransactionReceipt({ hash }));
    }

    async sendAndConfirm(params: { to?: Address; data: Hex; value?: bigint; label: string; requestId?: string }): Promise<{ txHash: Hex; receipt: TransactionReceipt }> {
        const { to, data, label, requestId } = params;
        const value = params.value ?? 0n;
        const network = this.payway.toUpperCase();
        const reqInfo = requestId ? `[${requestId}]` : '';

        const sender = this.account.address;
        // Nothing is signed yet, so a provider failing any preparation read is skipped for the next one
        const { client, gas, chainId, fees } = await this.onAnyProvider(async (candidate) => ({
            client: candidate,
            // 20% over the node estimate; never below it (Arbitrum estimates carry the L1 data component)
            gas: ((await candidate.estimateGas({ account: this.account, to, data, value })) * 120n) / 100n,
            chainId: await candidate.getChainId(),
            fees: await this.buildInitialFees(candidate)
        }));

        let lease = await nonceAllocator.reserveNonce(client, sender, chainId);
        const ownHashes = new Set<Hex>();
        let refreshes = 0;
        let success = false;

        try {
            const maxAttempts = 4;

            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                const tx: any = { to, data, value, gas, nonce: lease.nonce, chainId };
                if (fees.type2) {
                    tx.maxFeePerGas = fees.maxFeePerGas;
                    tx.maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
                } else {
                    tx.gasPrice = fees.gasPrice;
                }
                const rawTx = await this.account.signTransaction(tx);
                ownHashes.add(keccak256(rawTx));
                logger.info(network, `🔄${reqInfo}[${label} ATTEMPT ${attempt}/${maxAttempts}][RAW:${keccak256(rawTx)}]`);

                try {
                    const sent = await this.fanoutSend(rawTx, true, requestId, ownHashes);
                    success = true;
                    logger.info(network, `✅${reqInfo}[${label}][${sent.via}][HASH:${sent.txHash}]`);
                    return { txHash: sent.txHash, receipt: sent.receipt as TransactionReceipt };
                } catch (error: any) {
                    if (error instanceof EvmNonceTakenError) {
                        const fresh = await this.refreshTakenNonce(lease, refreshes, error, client, chainId, requestId);
                        if (fresh) {
                            lease = fresh;
                            refreshes += 1;
                            attempt = 0;
                            continue;
                        }
                    }
                    if (await this.handleMinimumTipError(error, fees, client)) continue;
                    if (this.shouldBumpFees(error?.message || '') && attempt < maxAttempts) {
                        this.bumpFees(fees);
                        logger.warn(network, `🔄${reqInfo}[${label} REPLACE_RETRY ${attempt + 1}/${maxAttempts}]`);
                        continue;
                    }
                    throw error;
                }
            }
            throw new Error(`All attempts failed for payway = ${this.payway} (${label})`);
        } finally {
            await lease.release(success);
        }
    }
}
