/* External dependencies */
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { Address, Hex, createPublicClient, encodeFunctionData, http, keccak256, parseUnits, type PublicClient } from 'viem';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { Recipient } from '../interfaces/payout.interface';
import { getChainForPayway, isEvmNetworkError } from '../utils/evm';
import { getEvmRpcUrlsForPayway, EVMTransactionLogger } from '../utils/modules';

/* Constants */
import { Const } from '../constants/const';

/* Gas helpers */
const { GWEI, TIP_FLOOR_POLYGON, MAX_TIP_CAP, MAX_FEE_CAP } = Const.EVM_FEE;

/**
 * Multi-send with original decimals logic (from multiSend contract) + safe replacement/bump.
 * Public API unchanged: init(), multiSend().
 */
export class MultiPayoutService {
    private rpcUrls!: string[];
    private multiSendContractAddress!: string;

    constructor(private payway: string, private privateKey: string) {}

    async init(multiSendContractAddress: string) {
        this.rpcUrls = getEvmRpcUrlsForPayway(this.payway);
        if (!this.rpcUrls.length) {
            throw new Error(`No RPC providers configured for payway = ${this.payway}`);
        }
        this.multiSendContractAddress = multiSendContractAddress;
    }

    /**
     * Convert human-readable amount to base units using bigint.
     */
    private convertToBaseUnit(amount: string, decimals: number): bigint {
        return parseUnits(amount, decimals);
    }

    /**
     * Build initial fees: EIP-1559 if baseFee present, otherwise legacy gasPrice
     * Applies Polygon-specific tip floor when needed
     */
    private async buildInitialFees(client: PublicClient): Promise<{
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
        } catch {}
        if (tip === 0n) tip = 2n * GWEI;

        const isPolygon = this.payway.toLowerCase().includes('polygon') || chainId === 80002 || chainId === 137;
        if (isPolygon && tip < TIP_FLOOR_POLYGON) tip = TIP_FLOOR_POLYGON;

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

    /**
     * Fee bump for replacement attempts
     * In EIP-1559 mode: +5 gwei to tip, +20% to maxFee (clamped)
     * In legacy mode: +15% to gasPrice
     */
    private bumpFees(fees: {
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

    /**
     * Check if error requires fee bump
     */
    private shouldBumpFees(errorMessage: string): boolean {
        const msg = errorMessage.toLowerCase();
        return Const.FEE_BUMP_ERROR_PATTERNS.some(pattern => msg.includes(pattern));
    }

    /**
     * Handle network errors that require higher minimum tip
     */
    private async handleMinimumTipError(
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
            const needed = match ? BigInt(match[1]) : TIP_FLOOR_POLYGON;

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
            logger.warn(this.payway.toUpperCase(), `⚠️ RPC requires higher tip; raising to ≥ ${neededGwei} Gwei`);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Log successful transaction
     */
    private async logSuccessfulTransaction(
        result: { txHash: string; receipt: any; via: string },
        currency: string
    ): Promise<void> {
        await EVMTransactionLogger.logSuccess(
            this.payway,
            currency,
            result.txHash,
            result.receipt,
            result.via,
            undefined,
            undefined,
            true
        );
    }

    /**
     * Log transaction error
     */
    private async logTransactionError(
        error: any,
        currency: string
    ): Promise<void> {
        await EVMTransactionLogger.logError(
            this.payway,
            currency,
            error,
            '',
            undefined,
            true
        );
    }

    /**
     * Get decimals from multi-send contract with fallback to 18
     */
    private async getContractDecimals(client: PublicClient, contractAddress: Address): Promise<number> {
        try {
            const decVal = await client.readContract({
                address: contractAddress,
                abi: Const.MULTI_SEND_ABI_CONTRACT as any,
                functionName: 'decimals'
            });
            const decNum = Number(decVal);
            if (Number.isFinite(decNum)) {
                logger.info(this.payway.toUpperCase(), `[DECIMALS] from multisend = ${decNum}`);
                return decNum;
            }
        } catch {
            logger.warn(this.payway.toUpperCase(), `[DECIMALS] multisend.decimals() failed, fallback = 18`);
        }
        return 18;
    }

    /**
     * Prepare transaction data for multi-send
     */
    private prepareMultiSendData(recipients: Recipient[], decimals: number): { addresses: Address[]; amounts: bigint[] } {
        return {
            addresses: recipients.map((r) => r.address as Address),
            amounts: recipients.map((r) => this.convertToBaseUnit(r.amount, decimals))
        };
    }

    /**
     * Estimate gas for multi-send transaction
     */
    private async estimateMultiSendGas(
        client: PublicClient,
        account: PrivateKeyAccount,
        contractAddress: Address,
        data: string
    ): Promise<number> {
        const estimatedGas = await client.estimateGas({
            account,
            to: contractAddress,
            data: data as Hex,
            value: 0n
        });
        return Math.min(Number(estimatedGas) + 10000, Const.MULTI_SEND_GAS_LIMIT);
    }

    /**
     * Prepare call data, gas, sender, pending nonce, chainId using the first healthy RPC
     */
    private async prepareCommon(
        recipients: Recipient[],
        multiSendContract: string,
    ): Promise<{
        client: PublicClient;
        sender: Address;
        chainId: number;
        nonce: number;
        gas: number;
        data: string;
        account: PrivateKeyAccount;
    }> {
        let lastErr: any;
        const chain = getChainForPayway(this.payway);
        const account = privateKeyToAccount(
            (this.privateKey.startsWith('0x') ? this.privateKey : `0x${this.privateKey}`) as Hex
        );

        for (const url of this.rpcUrls) {
            const transport = http(url, { timeout: 10000 });
            const client = createPublicClient({ chain, transport });

            try {
                const sender = account.address;
                const decimals = await this.getContractDecimals(client, multiSendContract as Address);
                const { addresses, amounts } = this.prepareMultiSendData(recipients, decimals);

                const data = encodeFunctionData({
                    abi: Const.MULTI_SEND_ABI_CONTRACT as any,
                    functionName: 'multiSend',
                    args: [addresses, amounts]
                });

                const gas = await this.estimateMultiSendGas(client, account, multiSendContract as Address, data);
                const [nonce, chainId] = await Promise.all([
                    client.getTransactionCount({ address: sender, blockTag: 'pending' }),
                    client.getChainId()
                ]);

                return { client, sender, chainId, nonce, gas, data, account };
            } catch (err: any) {
                lastErr = err;
                logger.error('MULTI_PREP', `❌  [${url}] prepare failed: ${err?.message || err}`);
                if (!isEvmNetworkError(err)) throw err;
                logger.warn('MULTI_PREP', '⚠️ Trying next provider...');
            }
        }

        throw new Error(`All RPC providers failed during multi-send preparation: ${lastErr?.message || lastErr}`);
    }

    /**
     * Send rawTx with failover, stop at first success
     */
    private async fanoutSend(rawTx: Hex): Promise<{ txHash: string; receipt: any; via: string }> {
        let lastErr: any;
        const chain = getChainForPayway(this.payway);
        for (const url of this.rpcUrls) {
            const client = createPublicClient({
                chain,
                transport: http(url, { timeout: 10000 })
            });
            try {
                const hash = await client.sendRawTransaction({ serializedTransaction: rawTx });
                const receipt = await client.waitForTransactionReceipt({ hash });
                return { txHash: receipt.transactionHash, receipt, via: url };
            } catch (err: any) {
                lastErr = err;
                const msg = err?.message || err?.toString?.() || String(err);
                logger.error('MULTI_SEND', `❌  [${url}] ${msg}`);
                if (!isEvmNetworkError(err)) throw err;
            }
        }
        throw lastErr;
    }

    /**
     * Create transaction object with current fees
     */
    private createTransactionObject(
        sender: Address,
        multiSendContract: string,
        data: string,
        gas: number,
        nonce: number,
        chainId: number,
        fees: any
    ): any {
        const tx: any = {
            account: sender as Hex,
            to: multiSendContract as Address,
            data,
            gas: BigInt(gas),
            nonce,
            chainId,
        };

        if (fees.type2) {
            tx.maxFeePerGas = fees.maxFeePerGas as bigint;
            tx.maxPriorityFeePerGas = fees.maxPriorityFeePerGas as bigint;
        } else {
            tx.gasPrice = fees.gasPrice as bigint;
        }

        return tx;
    }

    /**
     * - Prepare once (pending nonce)
     * - Fees: EIP-1559 if supported, else legacy
     * - Up to 4 attempts with bump & re-sign on replacement errors
     * - Fan-out per attempt until one RPC accepts
     */
    async multiSend(recipients: Recipient[], multiSendContract: string, currency: string): Promise<string> {
        const network = this.payway.toUpperCase();
        const prep = await this.prepareCommon(recipients, multiSendContract);
        const { client, sender, chainId, nonce, gas, data, account } = prep;

        let fees = await this.buildInitialFees(client);
        const maxAttempts = 4;
        let lastErr: any;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const tx = this.createTransactionObject(sender, multiSendContract, data, gas, nonce, chainId, fees);
            const rawTx = await account.signTransaction(tx);
            const rawHash = keccak256(rawTx);
            logger.info(network, `✍️ Attempt ${attempt}/${maxAttempts} — rawHash ${rawHash}`);

            try {
                const res = await this.fanoutSend(rawTx);
                await this.logSuccessfulTransaction(res, currency);
                return res.txHash;
            } catch (err: any) {
                lastErr = err;

                // Handle minimum tip requirements
                if (await this.handleMinimumTipError(err, fees, client)) {
                    continue;
                }

                // Handle replacement transaction errors
                if (this.shouldBumpFees(err?.message || '') && attempt < maxAttempts) {
                    this.bumpFees(fees);
                    logger.warn(network, `⚠️ Replacement bump & retry (${attempt + 1}/${maxAttempts})`);
                    continue;
                }

                // Handle network vs non-network errors
                if (!isEvmNetworkError(err)) {
                    await this.logTransactionError(err, currency);
                    throw new Error(
                        `Transaction failed for payway = ${this.payway} (multi-send): ${err?.message || err}`,
                    );
                }

                // Final attempt failed
                if (attempt === maxAttempts) {
                    await this.logTransactionError(err, currency);
                    throw new Error(
                        `All attempts failed for payway = ${this.payway} (multi-send): ${err?.message || err}`,
                    );
                }
            }
        }

        throw new Error(
            `All attempts failed for payway = ${this.payway} (multi-send): ${lastErr?.message || lastErr}`,
        );
    }
}
