/* External dependencies */
import { Address, Hex, createPublicClient, encodeFunctionData, http, keccak256, parseUnits, type PublicClient } from 'viem';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { isEvmNetworkError } from '../utils/evm';
import { EVMTransactionLogger } from '../utils/modules';
import { NativeTransfer, TokenTransfer } from '../interfaces/payout.interface';

/* Constants */
import { Const } from '../constants/const';

import { BaseEvmService } from './base.evm.service';

export class EvmBatchPayoutService extends BaseEvmService {
    private batchSendContractAddress!: Address;

    constructor(payway: string, privateKey: string) {
        super(payway, privateKey);
    }

    async init(batchSendContractAddress: string) {
        this.initBase();
        this.batchSendContractAddress = batchSendContractAddress as Address;
    }

    private async logSuccessfulTransaction(
        result: { txHash: string; receipt: any; via: string },
        currency: string,
        requestId?: string
    ): Promise<void> {
        await EVMTransactionLogger.logSuccess(
            this.payway,
            currency,
            result.txHash,
            result.receipt,
            result.via,
            undefined,
            undefined,
            true,
            requestId
        );
    }

    private async logTransactionError(
        error: any,
        currency: string,
        requestId?: string
    ): Promise<void> {
        await EVMTransactionLogger.logError(
            this.payway,
            currency,
            error,
            '',
            undefined,
            true,
            requestId
        );
    }

    private createTransactionObject(
        sender: Address,
        to: Address,
        data: string,
        gas: number,
        nonce: number,
        chainId: number,
        value: bigint,
        fees: any
    ): any {
        const tx: any = {
            account: sender as Hex,
            to,
            data,
            gas: BigInt(gas),
            nonce,
            chainId,
            value
        };

        if (fees.type2) {
            tx.maxFeePerGas = fees.maxFeePerGas as bigint;
            tx.maxPriorityFeePerGas = fees.maxPriorityFeePerGas as bigint;
        } else {
            tx.gasPrice = fees.gasPrice as bigint;
        }

        return tx;
    }

    private waitForReceiptInBackground(
        hash: Hex,
        via: string,
        currency: string,
        requestId?: string
    ): void {
        const client = createPublicClient({
            chain: this.chain,
            transport: http(via, { timeout: 10000 })
        });
        void (async () => {
            try {
                const receipt = await client.waitForTransactionReceipt({ hash });
                await this.logSuccessfulTransaction(
                    { txHash: receipt.transactionHash, receipt, via },
                    currency,
                    requestId
                );
            } catch (error) {
                await this.logTransactionError(error, currency, requestId);
            }
        })();
    }

    private async resolveTokenMapping(
        client: PublicClient,
        tokenTransfers: TokenTransfer[]
    ): Promise<Map<Address, { decimals: number; requiredBase: bigint }>> {
        const tokenMap = new Map<Address, { decimals: number; requiredBase: bigint }>();
        const uniqueTokens = Array.from(new Set(tokenTransfers.map(t => t.token_address as Address)));

        await Promise.all(
            uniqueTokens.map(async (token) => {
                const dec = await this.getContractDecimals(client, token);
                tokenMap.set(token, { decimals: dec, requiredBase: 0n });
            })
        );

        for (const transfer of tokenTransfers) {
            const tokenAddr = transfer.token_address as Address;
            const meta = tokenMap.get(tokenAddr)!;
            const baseAmount = this.convertToBaseUnit(transfer.amount, meta.decimals);
            meta.requiredBase += baseAmount;
        }

        return tokenMap;
    }

    private async checkAndApproveTokens(
        client: PublicClient,
        tokenMap: Map<Address, { decimals: number; requiredBase: bigint }>,
        requestId?: string
    ) {
        let sender = this.account.address;

        for (const [tokenAddr, meta] of tokenMap.entries()) {
            if (meta.requiredBase === 0n) continue;

            const allowance = await client.readContract({
                address: tokenAddr,
                abi: Const.ERC20_ABI as any,
                functionName: 'allowance',
                args: [sender, this.batchSendContractAddress]
            }) as bigint;

            if (allowance < meta.requiredBase) {
                logger.info(this.payway.toUpperCase(), `🔄[APPROVE_NEEDED][TOKEN:${tokenAddr}][REQUIRED:${meta.requiredBase}][ALLOWANCE:${allowance}]`);

                const data = encodeFunctionData({
                    abi: Const.ERC20_ABI as any,
                    functionName: 'approve',
                    args: [this.batchSendContractAddress, 2n ** 256n - 1n]
                });

                await this.sendEvmTx(
                    tokenAddr,
                    data,
                    0n,
                    true,
                    'APPROVE',
                    requestId
                );
                logger.info(this.payway.toUpperCase(), `✅[APPROVE_SUCCESS][TOKEN:${tokenAddr}]`);
            }
        }
    }

    private async sendEvmTx(
        to: Address,
        data: string,
        value: bigint,
        waitForReceipt: boolean,
        context: string,
        requestId?: string,
        currency?: string
    ): Promise<string> {
        const client = this.getFirstHealthyClient();
        const sender = this.account.address;
        const estimatedGas = await client.estimateGas({
            account: this.account,
            to,
            data: data as Hex,
            value
        });
        const gas = Math.min(Number(estimatedGas) + 20000, Const.MULTI_SEND_GAS_LIMIT * 2);

        const [nonce, chainId] = await Promise.all([
            client.getTransactionCount({ address: sender, blockTag: 'pending' }),
            client.getChainId()
        ]);

        let fees = await this.buildInitialFees(client);
        const maxAttempts = 4;
        let lastErr: any;

        const network = this.payway.toUpperCase();

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const tx = this.createTransactionObject(sender, to, data, gas, nonce, chainId, value, fees);
            const rawTx = await this.account.signTransaction(tx);
            const rawHash = keccak256(rawTx);
            const reqInfo = requestId ? `[${requestId}]` : '';
            logger.info(network, `🔄${reqInfo}[${context} ATTEMPT ${attempt}/${maxAttempts}][RAW:${rawHash}]`);

            try {
                const res = await this.fanoutSend(rawTx, waitForReceipt);
                if (waitForReceipt && currency && context === 'BATCH_SEND') {
                    await this.logSuccessfulTransaction(
                        { txHash: res.txHash, receipt: res.receipt as any, via: res.via },
                        currency,
                        requestId
                    );
                } else if (!waitForReceipt && currency && context === 'BATCH_SEND') {
                    this.logTransactionSubmitted(res.txHash, res.via, requestId);
                    this.waitForReceiptInBackground(res.txHash, res.via, currency, requestId);
                }
                return res.txHash;
            } catch (err: any) {
                lastErr = err;

                if (await this.handleMinimumTipError(err, fees, client)) {
                    continue;
                }

                if (this.shouldBumpFees(err?.message || '') && attempt < maxAttempts) {
                    this.bumpFees(fees);
                    logger.warn(network, `🔄${reqInfo}[${context} REPLACE_RETRY ${attempt + 1}/${maxAttempts}]`);
                    continue;
                }

                if (!isEvmNetworkError(err)) {
                    if (currency && context === 'BATCH_SEND') await this.logTransactionError(err, currency, requestId);
                    throw new Error(`${context} failed for payway = ${this.payway}: ${err?.message || err}`);
                }

                if (attempt === maxAttempts) {
                    if (currency && context === 'BATCH_SEND') await this.logTransactionError(err, currency, requestId);
                    throw new Error(`All attempts failed for payway = ${this.payway} (${context}): ${err?.message || err}`);
                }
            }
        }

        throw new Error(`All attempts failed for payway = ${this.payway} (${context}): ${lastErr?.message || lastErr}`);
    }

    async batchSend(
        nativeTransfers: NativeTransfer[] = [],
        tokenTransfers: TokenTransfer[] = [],
        currency?: string,
        waitForReceipt: boolean = true,
        requestId?: string
    ): Promise<string> {
        const logCurrency = currency || 'BATCH';
        const pClient = this.getFirstHealthyClient();

        const tokenMap = await this.resolveTokenMapping(pClient, tokenTransfers);
        await this.checkAndApproveTokens(pClient, tokenMap, requestId);

        let totalNative = 0n;
        const formattedNativeTransfers = [];
        for (const nt of nativeTransfers) {
            // Defaulting native token decimals to 18
            const baseAmount = this.convertToBaseUnit(nt.amount, 18);
            totalNative += baseAmount;
            formattedNativeTransfers.push({ to: nt.to as Address, amount: baseAmount });
        }

        const formattedTokenTransfers = [];
        for (const tt of tokenTransfers) {
            const dec = tokenMap.get(tt.token_address as Address)!.decimals;
            const baseAmount = this.convertToBaseUnit(tt.amount, dec);
            formattedTokenTransfers.push({
                token: tt.token_address as Address,
                to: tt.to as Address,
                amount: baseAmount
            });
        }

        const data = encodeFunctionData({
            abi: Const.PUBLIC_MULTI_SEND_V1_ABI as any,
            functionName: 'batchSend',
            args: [formattedNativeTransfers, formattedTokenTransfers]
        });

        return this.sendEvmTx(
            this.batchSendContractAddress,
            data,
            totalNative,
            waitForReceipt,
            'BATCH_SEND',
            requestId,
            logCurrency
        );
    }
}
