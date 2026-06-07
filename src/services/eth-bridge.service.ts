/* External dependencies */
import { arbitrumSepolia } from 'viem/chains';
import { createPublicClient, http, encodeFunctionData, parseEther, keccak256, type Address, type Hex, type PublicClient } from 'viem';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { isEvmNetworkError } from '../utils/evm';
import { nonceAllocator, type NonceLease } from '../utils/nonce-allocator';

/* Constants */
import { Const } from '../constants/const';

/* Interfaces */
import { BridgeDestination } from '../interfaces/bridge.interface';

import { BaseEvmService } from './base.evm.service';

/** Resolved L1 payable call for a single deposit route. */
type BridgeRoute = {
    to: Address;
    value: bigint;
    data: Hex;
};

/**
 * Service for native ETH L1->L2 deposits (bridging) from Sepolia.
 *
 * Reuses BaseEvmService infrastructure (RPC fail-over over Sepolia, send
 * recovery) and the shared nonce allocator. Each deposit is a single payable
 * call on the relevant L1 bridge contract:
 *   - Base (OP Stack):  L1StandardBridge.depositETH / bridgeETHTo
 *   - Arbitrum (Nitro): Inbox.depositEth / createRetryableTicket
 *
 * The returned hash is the L1 deposit transaction; funds arrive on the L2
 * asynchronously afterwards (≈minutes for Base, ≈10-15 min for Arbitrum).
 */
export class EthBridgeService extends BaseEvmService {
    constructor(privateKey: string) {
        // Source chain is always Sepolia L1 — reuse the 'eth' payway chain / RPC pool.
        super('eth', privateKey);
    }

    async init(): Promise<void> {
        this.initBase();
    }

    /**
     * Legacy gas price for the L1 transaction, mirroring PayoutService's congestion multiplier.
     */
    private async getL1GasPrice(client: PublicClient): Promise<bigint> {
        const gp = await client.getGasPrice();
        const GWEI = Const.EVM_FEE.GWEI;
        if (gp < 20n * GWEI) return (gp * 3n) / 2n;
        if (gp < 50n * GWEI) return gp * 2n;
        return (gp * 21n) / 10n;
    }

    /**
     * Current Arbitrum L2 gas price (buffered, with a floor) for the retryable ticket bid.
     */
    private async getArbitrumL2GasPrice(): Promise<bigint> {
        const floor = Const.ARBITRUM_L2_GAS_PRICE_FLOOR;
        for (const url of Const.EVM_RPC_PROVIDERS.arbitrum_eth) {
            try {
                const client = createPublicClient({ chain: arbitrumSepolia, transport: http(url, { timeout: 10000 }) });
                const gp = await client.getGasPrice();
                const bumped = gp * Const.ARBITRUM_FEE_BUFFER_FACTOR;
                return bumped < floor ? floor : bumped;
            } catch {
                continue;
            }
        }
        return floor;
    }

    /**
     * Arbitrum retryable submission fee read from the Inbox (buffered).
     * Passing baseFee=0 makes the contract use the current L1 block.basefee.
     */
    private async getArbitrumSubmissionFee(l1Client: PublicClient): Promise<bigint> {
        const raw = await l1Client.readContract({
            address: Const.ARBITRUM_SEPOLIA_INBOX as Address,
            abi: Const.ARBITRUM_INBOX_ABI,
            functionName: 'calculateRetryableSubmissionFee',
            args: [0n, 0n]
        });
        return (raw as bigint) * Const.ARBITRUM_FEE_BUFFER_FACTOR;
    }

    /**
     * OP Stack (Base) deposit call. Self-deposit uses depositETH; an explicit
     * recipient uses bridgeETHTo.
     */
    private buildBaseRoute(amount: string, payeeAddress?: string): BridgeRoute {
        const value = parseEther(amount);
        const minGasLimit = Const.OP_DEPOSIT_MIN_GAS_LIMIT;

        const data = payeeAddress
            ? encodeFunctionData({
                abi: Const.L1_STANDARD_BRIDGE_ABI,
                functionName: 'bridgeETHTo',
                args: [payeeAddress as Address, minGasLimit, '0x']
            })
            : encodeFunctionData({
                abi: Const.L1_STANDARD_BRIDGE_ABI,
                functionName: 'depositETH',
                args: [minGasLimit, '0x']
            });

        return { to: Const.BASE_SEPOLIA_L1_STANDARD_BRIDGE as Address, value, data };
    }

    /**
     * Arbitrum (Nitro) deposit call.
     * - self  -> Inbox.depositEth() (credits the sender's own address on L2)
     * - payee -> Inbox.createRetryableTicket(...) (arbitrary recipient)
     */
    private async buildArbitrumRoute(l1Client: PublicClient, amount: string, payeeAddress?: string): Promise<BridgeRoute> {
        const to = Const.ARBITRUM_SEPOLIA_INBOX as Address;
        const l2CallValue = parseEther(amount);

        if (!payeeAddress) {
            const data = encodeFunctionData({
                abi: Const.ARBITRUM_INBOX_ABI,
                functionName: 'depositEth',
                args: []
            });
            return { to, value: l2CallValue, data };
        }

        const recipient = payeeAddress as Address;
        const [submissionFee, maxFeePerGas] = await Promise.all([
            this.getArbitrumSubmissionFee(l1Client),
            this.getArbitrumL2GasPrice()
        ]);
        const gasLimit = Const.ARBITRUM_RETRYABLE_GAS_LIMIT;

        // msg.value must cover the L2 call value plus both retryable fee components.
        const value = l2CallValue + submissionFee + gasLimit * maxFeePerGas;

        const data = encodeFunctionData({
            abi: Const.ARBITRUM_INBOX_ABI,
            functionName: 'createRetryableTicket',
            args: [recipient, l2CallValue, submissionFee, recipient, recipient, gasLimit, maxFeePerGas, '0x']
        });

        return { to, value, data };
    }

    private async resolveRoute(client: PublicClient, destination: BridgeDestination, amount: string, payeeAddress?: string): Promise<BridgeRoute> {
        if (destination === 'base') {
            return this.buildBaseRoute(amount, payeeAddress);
        }
        if (destination === 'arbitrum') {
            return this.buildArbitrumRoute(client, amount, payeeAddress);
        }
        throw new Error(`Unsupported bridge destination: ${destination}`);
    }

    /**
     * Builds and signs the L1 deposit transaction over the first healthy Sepolia RPC.
     */
    private async prepareDepositTx(
        destination: BridgeDestination,
        amount: string,
        payeeAddress?: string
    ): Promise<{ rawTx: Hex; sender: Hex; nonceLease: NonceLease; chainId: number }> {
        let lastErr: any;
        const account = this.account;

        for (const url of this.rpcUrls) {
            const client = createPublicClient({ chain: this.chain, transport: http(url, { timeout: 10000 }) }) as PublicClient;

            try {
                const route = await this.resolveRoute(client, destination, amount, payeeAddress);
                const [chainId, gasPrice] = await Promise.all([client.getChainId(), this.getL1GasPrice(client)]);

                const tx: any = {
                    chainId,
                    gasPrice,
                    to: route.to,
                    value: route.value,
                    data: route.data
                };

                const estimatedGas = await client.estimateGas({ ...tx, account: account.address } as any);
                tx.gas = (estimatedGas * 13n) / 10n; // +30% buffer for bridge entrypoints

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
                logger.error('BRIDGE_PREP', `❌[PREPARE_FAILED][DEST:${destination}][MSG:${err?.message || err?.toString?.() || String(err)}]`);
                if (!isEvmNetworkError(err)) {
                    throw err;
                }
                logger.warn('BRIDGE_PREP', '🔄[PREPARE_RETRY][NEXT_PROVIDER]');
            }
        }

        throw new Error(`All RPC providers failed during bridge tx preparation: ${lastErr?.message || lastErr?.toString?.() || String(lastErr)}`);
    }

    /**
     * Deposits native ETH from Sepolia to the chosen L2.
     * @returns the L1 deposit transaction hash (L2 crediting is asynchronous).
     */
    async deposit(
        destination: BridgeDestination,
        amount: string,
        payeeAddress?: string,
        waitForReceipt: boolean = true,
        requestId?: string
    ): Promise<string> {
        const label = `BRIDGE→${destination.toUpperCase()}`;
        const reqInfo = requestId ? `[${requestId}]` : '';

        const { rawTx, sender, nonceLease } = await this.prepareDepositTx(destination, amount, payeeAddress);
        logger.info(label, `🧾${reqInfo}[PREPARED][HASH:${keccak256(rawTx)}][L2_RECIPIENT:${payeeAddress || sender}]`);

        let success = false;
        try {
            const { txHash, via } = await this.fanoutSend(rawTx, waitForReceipt, requestId);
            success = true;
            logger.info(label, `✅${reqInfo}[L1_DEPOSIT_SENT][${via}][L1_TX:${txHash}]`);
            return txHash;
        } catch (err: any) {
            logger.error(label, `❌${reqInfo}[FAILED][MSG:${err?.message || err?.toString?.() || String(err)}]`);
            throw err;
        } finally {
            await nonceLease.release(success);
        }
    }
}
