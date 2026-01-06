/* External dependencies */
import Web3 from 'web3';
import { Contract } from 'web3-eth-contract';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { modules } from '../utils/modules';
import { Recipient } from '../interfaces/payout.interface';
import { notifierMessage } from '../utils/message-formatter';

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
        this.rpcUrls = modules.getEvmRpcUrlsForPayway(this.payway);
        if (!this.rpcUrls.length) {
            throw new Error(`No RPC providers configured for payway = ${this.payway}`);
        }
        this.multiSendContractAddress = multiSendContractAddress;
    }

    /**
     * Infra/network error classifier for failover
     */
    private isNetworkError(err: any): boolean {
        const msg = (err?.message || err?.data?.message || err?.toString?.() || '').toLowerCase();
        return (Const.NETWORK_ERROR_PATTERNS as string[]).some((sub) => msg.includes(sub));
    }

    /**
     * Const.DECIMALS + web3.utils.toWei(amount, unit)
     */
    private convertToBaseUnit(web3: Web3, amount: string, decimals: number): string {
        const unit = (Const.DECIMALS as Record<number, string>)[decimals];
        if (!unit) throw new Error(`Unsupported token decimals: ${decimals}`);
        return web3.utils.toWei(amount, unit as any);
    }

    /**
     * Build initial fees: EIP-1559 if baseFee present, otherwise legacy gasPrice
     * Applies Polygon-specific tip floor when needed
     */
    private async buildInitialFees(web3: Web3): Promise<{
        type2: boolean;
        maxFeePerGas?: bigint;
        maxPriorityFeePerGas?: bigint;
        gasPrice?: bigint;
    }> {
        const [chainId, blk] = await Promise.all([
            web3.eth.getChainId(),
            web3.eth.getBlock('pending') as any,
        ]);

        const baseFee = blk?.baseFeePerGas != null ? BigInt(blk.baseFeePerGas) : 0n;

        let tip = 0n;
        try {
            const tipHex =
                (web3 as any).eth?.request?.({ method: 'eth_maxPriorityFeePerGas', params: [] }) ??
                null;
            const val = await tipHex;
            tip = val ? BigInt(val) : 0n;
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

        const gp = BigInt(await web3.eth.getGasPrice());
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
     * Prepare call data, gas, sender, pending nonce, chainId using the first healthy RPC
     */
    private async prepareCommon(
        recipients: Recipient[],
        multiSendContract: string,
    ): Promise<{
        web3: Web3;
        sender: string;
        chainId: number;
        nonce: number;
        gas: number;
        data: string;
    }> {
        let lastErr: any;

        for (const url of this.rpcUrls) {
            const web3 = new Web3(new Web3.providers.HttpProvider(url, { timeout: 10000 }));
            try {
                web3.eth.accounts.wallet.clear();
                web3.eth.accounts.wallet.add(this.privateKey);
                const sender = web3.eth.accounts.wallet[0].address;

                const multi: Contract = new web3.eth.Contract(Const.MULTI_SEND_ABI_CONTRACT, multiSendContract);

                let decimals = 18;
                try {
                    const decStr: string = await (multi.methods as any).decimals?.().call();
                    const decNum = Number(decStr);
                    if (Number.isFinite(decNum)) decimals = decNum;
                    logger.info(this.payway.toUpperCase(), `[DECIMALS] from multisend = ${decimals}`);
                } catch {
                    logger.warn(this.payway.toUpperCase(), `[DECIMALS] multisend.decimals() failed, fallback = 18`);
                }

                const addrs = recipients.map((r) => r.address);
                const amts = recipients.map((r) => this.convertToBaseUnit(web3, r.amount, decimals));

                const data = multi.methods.multiSend(addrs, amts).encodeABI();

                const estimatedGas: number = await multi.methods
                    .multiSend(addrs, amts)
                    .estimateGas({ from: sender, value: 0 });
                const gas = Math.min(estimatedGas + 10_000, Const.MULTI_SEND_GAS_LIMIT);

                const nonce = await web3.eth.getTransactionCount(sender, 'pending');
                const chainId = await web3.eth.getChainId();

                return { web3, sender, chainId, nonce, gas, data };
            } catch (err: any) {
                lastErr = err;
                logger.error('MULTI_PREP', `❌  [${url}] prepare failed: ${err?.message || err}`);
                if (!this.isNetworkError(err)) throw err;
                logger.warn('MULTI_PREP', '⚠️ Trying next provider...');
            }
        }

        throw new Error(`All RPC providers failed during multi-send preparation: ${lastErr?.message || lastErr}`);
    }

    /**
     * Send rawTx with failover, stop at first success
     */
    private async fanoutSend(rawTx: string): Promise<{ txHash: string; receipt: any; via: string }> {
        let lastErr: any;
        for (const url of this.rpcUrls) {
            const w = new Web3(new Web3.providers.HttpProvider(url, { timeout: 10_000 }));
            try {
                const receipt = await w.eth.sendSignedTransaction(rawTx);
                return { txHash: receipt.transactionHash, receipt, via: url };
            } catch (err: any) {
                lastErr = err;
                const msg = err?.message || err?.toString?.() || String(err);
                logger.error('MULTI_SEND', `❌  [${url}] ${msg}`);
                if (!this.isNetworkError(err)) throw err;
            }
        }
        throw lastErr;
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
        const { web3, sender, chainId, nonce, gas, data } = prep;

        let fees = await this.buildInitialFees(web3);

        const maxAttempts = 4;
        let lastErr: any;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const tx: any = {
                from: sender,
                to: multiSendContract,
                data,
                gas,
                nonce,
                chainId,
            };

            if (fees.type2) {
                tx.type = 2;
                tx.maxFeePerGas = '0x' + (fees.maxFeePerGas as bigint).toString(16);
                tx.maxPriorityFeePerGas = '0x' + (fees.maxPriorityFeePerGas as bigint).toString(16);
            } else {
                tx.gasPrice = '0x' + (fees.gasPrice as bigint).toString(16);
            }

            const signed = await web3.eth.accounts.signTransaction(tx, this.privateKey);
            const rawTx = signed.rawTransaction!;
            const rawHash = Web3.utils.keccak256(rawTx);
            logger.info(network, `✍️ Attempt ${attempt}/${maxAttempts} — rawHash ${rawHash}`);

            try {
                const res = await this.fanoutSend(rawTx);

                const okMsg = notifierMessage.formatSuccessMultiSend(this.payway, currency, res.receipt);
                logger.info(network, `✅ Success via [${res.via}] — txHash = ${res.txHash}`);
                logger.info(network, okMsg);
                await modules.sendMessageToTelegram(okMsg);

                return res.txHash;
            } catch (err: any) {
                lastErr = err;
                const m = (err?.message || '').toLowerCase();

                if (m.includes('minimum needed') || m.includes('gas price below minimum') || m.includes('tip cap')) {
                    try {
                        const match = (err.message || '').match(/minimum needed\s+(\d+)/i);
                        const needed = match ? BigInt(match[1]) : TIP_FLOOR_POLYGON;

                        if (fees.type2) {
                            if ((fees.maxPriorityFeePerGas as bigint) < needed) {
                                const pending = (await web3.eth.getBlock('pending')) as any;
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

                        logger.warn(network, `⚠️ RPC requires higher tip; raising to ≥ ${needed} wei and retrying`);
                        continue;
                    } catch {}
                }

                const needBump =
                    m.includes('replacement transaction underpriced') ||
                    m.includes('fee too low') ||
                    m.includes('nonce too low') ||
                    m.includes('already known');

                const isNetworkish = this.isNetworkError(err);

                if (needBump && attempt < maxAttempts) {
                    this.bumpFees(fees);
                    logger.warn(network, `⚠️ Replacement bump & retry (${attempt + 1}/${maxAttempts})`);
                    continue;
                }

                const errorMsg = notifierMessage.formatErrorMultiSend(
                    this.payway,
                    currency,
                    err?.message || err?.toString?.() || String(err),
                );
                await modules.sendMessageToTelegram(errorMsg);

                throw new Error(
                    `All RPC providers failed for payway = ${this.payway} (multi-send): ${err?.message || err}`,
                );
            }
        }

        throw new Error(
            `All RPC providers failed for payway = ${this.payway} (multi-send): ${lastErr?.message || lastErr}`,
        );
    }
}
