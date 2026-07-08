/* External dependencies */
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { Address, Hex, createPublicClient, http, keccak256, parseUnits, type PublicClient, type Chain } from 'viem';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { getChainForPayway, isEvmAlreadyKnownError, isEvmNetworkError } from '../utils/evm';
import { getEvmRpcUrlsForPayway, EVMTransactionLogger } from '../utils/modules';

/* Constants */
import { Const } from '../constants/const';

/* Gas helpers */
const { GWEI, TIP_FLOORS, MAX_TIP_CAP, MAX_FEE_CAP } = Const.EVM_FEE;

/**
 * Abstract base class for EVM operations.
 * Holds common RPC fail-over, gas estimation, fee bumping, and decoding utilities.
 */
export abstract class BaseEvmService {
    protected rpcUrls!: string[];
    protected account: PrivateKeyAccount;
    protected chain: Chain;
    protected decimalsCache: Record<string, number> = {};

    constructor(protected payway: string, protected privateKey: string) {
        this.chain = getChainForPayway(this.payway) as Chain;
        this.account = privateKeyToAccount(
            (this.privateKey.startsWith('0x') ? this.privateKey : `0x${this.privateKey}`) as Hex
        );
    }

    protected initBase() {
        this.rpcUrls = getEvmRpcUrlsForPayway(this.payway);
        if (!this.rpcUrls.length) {
            throw new Error(`No RPC providers configured for payway = ${this.payway}`);
        }
    }

    protected async getFirstHealthyClient(): Promise<PublicClient> {
        let lastErr: any;
        for (const url of this.rpcUrls) {
            const client = createPublicClient({
                chain: this.chain,
                transport: http(url, { timeout: 10000 })
            }) as PublicClient;
            try {
                // Real probe: exercise the same read the callers rely on (pending block).
                // A flaky provider (e.g. drpc.org returning -32006 under load) is skipped here
                // instead of blowing up later in buildInitialFees/estimateGas, which have no fallback.
                await client.getBlock({ blockTag: 'pending' as any });
                return client;
            } catch (err: any) {
                lastErr = err;
                logger.warn(this.payway.toUpperCase(), `⚠️[RPC_PROBE_FAIL][${url}][MSG:${err?.message || err}]`);
                continue;
            }
        }
        throw new Error(`All RPC providers failed during getFirstHealthyClient for ${this.payway}: ${lastErr?.message || lastErr}`);
    }

    protected convertToBaseUnit(amount: string, decimals: number): bigint {
        return parseUnits(amount, decimals);
    }

    protected async getContractDecimals(client: PublicClient, contractAddress: Address, fallback: number = 18): Promise<number> {
        const key = contractAddress.toLowerCase();
        if (this.decimalsCache[key] !== undefined) {
            return this.decimalsCache[key];
        }

        try {
            const decVal = await client.readContract({
                address: contractAddress as Address,
                abi: Const.ERC20_ABI as any,
                functionName: 'decimals'
            });
            const decNum = Number(decVal);
            if (Number.isFinite(decNum)) {
                this.decimalsCache[key] = decNum;
                logger.info(this.payway.toUpperCase(), `🧾[DECIMALS][SOURCE:contract][VALUE:${decNum}]`);
                return decNum;
            }
        } catch {
            logger.warn(this.payway.toUpperCase(), `⚠️[DECIMALS][SOURCE:erc20][CONTRACT:${contractAddress}][FALLBACK:${fallback}]`);
        }

        this.decimalsCache[key] = fallback;
        return fallback;
    }

    protected async buildInitialFees(client: PublicClient): Promise<{
        type2: boolean;
        maxFeePerGas?: bigint;
        maxPriorityFeePerGas?: bigint;
        gasPrice?: bigint;
    }> {
        const [chainId, blk] = await Promise.all([
            client.getChainId(),
            client.getBlock({ blockTag: 'pending' as any }) as any,
        ]);

        const baseFee = blk?.baseFeePerGas != null ? BigInt(blk.baseFeePerGas) : 0n;

        let tip = 0n;
        try {
            const val = await client.request({
                method: 'eth_maxPriorityFeePerGas',
                params: []
            } as any);
            tip = val ? BigInt(val as string) : 0n;
        } catch { }

        if (tip === 0n) tip = 2n * GWEI;

        const tipFloor = TIP_FLOORS[this.payway.toLowerCase()];
        if (tipFloor && tip < tipFloor) tip = tipFloor;

        if (baseFee > 0n) {
            let maxFee = baseFee * 2n + tip;
            if (maxFee < baseFee + tip) maxFee = baseFee + tip;

            if (tip > MAX_TIP_CAP) tip = MAX_TIP_CAP;
            if (maxFee > MAX_FEE_CAP) maxFee = MAX_FEE_CAP;

            return {
                type2: true,
                maxPriorityFeePerGas: tip,
                maxFeePerGas: maxFee,
            };
        }

        const gp = await client.getGasPrice();
        return { type2: false, gasPrice: gp };
    }

    protected bumpFees(fees: {
        type2: boolean;
        maxFeePerGas?: bigint;
        maxPriorityFeePerGas?: bigint;
        gasPrice?: bigint;
    }) {
        if (fees.type2) {
            const nextTip = (fees.maxPriorityFeePerGas as bigint) + 5n * GWEI;
            const nextFee = ((fees.maxFeePerGas as bigint) * 120n) / 100n;

            fees.maxPriorityFeePerGas = nextTip > MAX_TIP_CAP ? MAX_TIP_CAP : nextTip;
            fees.maxFeePerGas = nextFee > MAX_FEE_CAP ? MAX_FEE_CAP : nextFee;
        } else {
            fees.gasPrice = ((fees.gasPrice as bigint) * 115n) / 100n;
        }
    }

    protected shouldBumpFees(errorMessage: string): boolean {
        const msg = errorMessage.toLowerCase();
        return Const.FEE_BUMP_ERROR_PATTERNS.some(pattern => msg.includes(pattern));
    }

    protected async handleMinimumTipError(
        error: any,
        fees: any,
        client: PublicClient
    ): Promise<boolean> {
        const msg = (error.message || '').toLowerCase();
        if (!Const.MINIMUM_TIP_ERROR_PATTERNS.some(pattern => msg.includes(pattern))) {
            return false;
        }

        try {
            const match = (error.message || '').match(/minimum needed\s+(\d+)/i);
            const needed = match ? BigInt(match[1]) : (TIP_FLOORS[this.payway.toLowerCase()] ?? 2n * GWEI);

            if (fees.type2) {
                if ((fees.maxPriorityFeePerGas as bigint) < needed) {
                    const pending = (await client.getBlock({ blockTag: 'pending' as any })) as any;
                    const base = pending?.baseFeePerGas != null ? BigInt(pending.baseFeePerGas) : 0n;

                    let nextMaxFee = base > 0n ? base * 2n + needed : (fees.maxFeePerGas as bigint);
                    if (nextMaxFee < base + needed) nextMaxFee = base + needed;

                    const nextTip = needed > MAX_TIP_CAP ? MAX_TIP_CAP : needed;

                    fees.maxPriorityFeePerGas = nextTip;
                    fees.maxFeePerGas = nextMaxFee > MAX_FEE_CAP ? MAX_FEE_CAP : nextMaxFee;
                } else {
                    this.bumpFees(fees);
                }
            } else {
                this.bumpFees(fees);
            }

            const neededGwei = Number(needed) / Number(GWEI);
            logger.warn(this.payway.toUpperCase(), `⚠️[FEE_TIP_BUMP][NEEDED_GWEI:${neededGwei}]`);
            return true;
        } catch {
            return false;
        }
    }

    protected logTransactionSubmitted(hash: string, url: string, requestId?: string): void {
        const network = this.payway.toUpperCase();
        const reqInfo = requestId ? `[${requestId}]` : '';
        logger.info(network, `📨${reqInfo}[SUBMITTED][${url}][HASH:${hash}]`);
    }

    protected async recoverSubmittedTransaction(
        rawTx: Hex,
        waitForReceipt: boolean,
        preferredUrl: string,
        error: any,
        requestId?: string
    ): Promise<{ txHash: Hex; receipt?: any; via: string } | null> {
        if (!isEvmNetworkError(error) && !isEvmAlreadyKnownError(error)) {
            return null;
        }

        const txHash = keccak256(rawTx);
        const urls = [preferredUrl, ...this.rpcUrls.filter((url) => url !== preferredUrl)];
        const network = this.payway.toUpperCase();
        const reqInfo = requestId ? `[${requestId}]` : '';

        for (const url of urls) {
            const client = createPublicClient({
                chain: this.chain,
                transport: http(url, { timeout: 10000 })
            }) as PublicClient;

            try {
                const receipt = await client.getTransactionReceipt({ hash: txHash });
                logger.warn(network, `⚠️${reqInfo}[SEND_RECOVERED][${url}][MODE:receipt][HASH:${receipt.transactionHash}]`);
                return { txHash: receipt.transactionHash, receipt, via: url };
            } catch {
                // Continue with the next recovery strategy.
            }

            try {
                await client.getTransaction({ hash: txHash });

                if (!waitForReceipt) {
                    logger.warn(network, `⚠️${reqInfo}[SEND_RECOVERED][${url}][MODE:tx_lookup][HASH:${txHash}]`);
                    return { txHash, via: url };
                }

                const receipt = await client.waitForTransactionReceipt({ hash: txHash });
                logger.warn(network, `⚠️${reqInfo}[SEND_RECOVERED][${url}][MODE:wait_receipt][HASH:${receipt.transactionHash}]`);
                return { txHash: receipt.transactionHash, receipt, via: url };
            } catch {
                // Continue with the next recovery strategy.
            }

            if (isEvmAlreadyKnownError(error)) {
                if (!waitForReceipt) {
                    logger.warn(network, `⚠️${reqInfo}[SEND_RECOVERED][${url}][MODE:already_known][HASH:${txHash}]`);
                    return { txHash, via: url };
                }

                try {
                    const receipt = await client.waitForTransactionReceipt({ hash: txHash });
                    logger.warn(network, `⚠️${reqInfo}[SEND_RECOVERED][${url}][MODE:already_known_wait][HASH:${receipt.transactionHash}]`);
                    return { txHash: receipt.transactionHash, receipt, via: url };
                } catch {
                    // Try the next provider.
                }
            }
        }

        return null;
    }

    protected async fanoutSend(
        rawTx: Hex,
        waitForReceipt: boolean,
        requestId?: string
    ): Promise<{ txHash: Hex; receipt?: any; via: string }> {
        let lastErr: any;
        for (const url of this.rpcUrls) {
            const client = createPublicClient({
                chain: this.chain,
                transport: http(url, { timeout: 10000 })
            });
            try {
                const hash = await client.sendRawTransaction({ serializedTransaction: rawTx });
                if (waitForReceipt) {
                    const receipt = await client.waitForTransactionReceipt({ hash });
                    return { txHash: receipt.transactionHash, receipt, via: url };
                }
                return { txHash: hash, via: url };
            } catch (err: any) {
                lastErr = err;
                const recovered = await this.recoverSubmittedTransaction(rawTx, waitForReceipt, url, err, requestId);
                if (recovered) {
                    return recovered;
                }
                const msg = err?.message || err?.toString?.() || String(err);
                logger.error(this.payway.toUpperCase(), `❌[SEND_FAIL][${url}][MSG:${msg}]`);
                if (!isEvmNetworkError(err)) throw err;
            }
        }
        throw lastErr;
    }
}