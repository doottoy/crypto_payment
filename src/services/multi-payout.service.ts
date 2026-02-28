/* External dependencies */
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { Address, Hex, createPublicClient, encodeFunctionData, http, keccak256, parseUnits, type PublicClient } from 'viem';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { isEvmNetworkError } from '../utils/evm';
import { BaseEvmService } from './base.evm.service';
import { EVMTransactionLogger } from '../utils/modules';
import { Recipient } from '../interfaces/payout.interface';

/* Constants */
import { Const } from '../constants/const';

/**
 * Multi-send with original decimals logic (from multiSend contract) + safe replacement/bump.
 * Public API unchanged: init(), multiSend().
 */
export class MultiPayoutService extends BaseEvmService {
    private multiSendContractAddress!: string;

    constructor(payway: string, privateKey: string) {
        super(payway, privateKey);
    }

    async init(multiSendContractAddress: string) {
        this.initBase();
        this.multiSendContractAddress = multiSendContractAddress;
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

    private async getMultiSendContractDecimals(client: PublicClient, contractAddress: Address): Promise<number> {
        try {
            const decVal = await client.readContract({
                address: contractAddress,
                abi: Const.MULTI_SEND_ABI_CONTRACT as any,
                functionName: 'decimals'
            });
            const decNum = Number(decVal);
            if (Number.isFinite(decNum)) {
                logger.info(this.payway.toUpperCase(), `🧾[DECIMALS][SOURCE:multisend][VALUE:${decNum}]`);
                return decNum;
            }
        } catch {
            logger.warn(this.payway.toUpperCase(), '⚠️[DECIMALS][SOURCE:multisend][FALLBACK:18]');
        }
        return 18;
    }

    private prepareMultiSendData(recipients: Recipient[], decimals: number): { addresses: Address[]; amounts: bigint[] } {
        return {
            addresses: recipients.map((r) => r.address as Address),
            amounts: recipients.map((r) => this.convertToBaseUnit(r.amount, decimals))
        };
    }



    /**
     * Estimate gas for multi-send transaction.
     * Tries with totalValue first (payable contract), falls back to 0n (pre-funded contract).
     * Returns gas estimate and the actual value to attach to the transaction.
     */
    private async estimateMultiSendGas(
        client: PublicClient,
        account: PrivateKeyAccount,
        contractAddress: Address,
        data: string,
        totalValue: bigint
    ): Promise<{ gas: number; txValue: bigint }> {
        const network = this.payway.toUpperCase();

        // First try with totalValue (payable contract — e.g. BSC)
        try {
            const estimatedGas = await client.estimateGas({
                account,
                to: contractAddress,
                data: data as Hex,
                value: totalValue
            });
            logger.info(network, `🧾[MULTI_SEND][TYPE:payable][VALUE:${totalValue}]`);
            return {
                gas: Math.min(Number(estimatedGas) + 10000, Const.MULTI_SEND_GAS_LIMIT),
                txValue: totalValue
            };
        } catch {
            // ignore — try pre-funded path
        }

        // Fallback: pre-funded contract (value = 0)
        const estimatedGas = await client.estimateGas({
            account,
            to: contractAddress,
            data: data as Hex,
            value: 0n
        });
        logger.info(network, `🧾[MULTI_SEND][TYPE:pre-funded][VALUE:0]`);
        return {
            gas: Math.min(Number(estimatedGas) + 10000, Const.MULTI_SEND_GAS_LIMIT),
            txValue: 0n
        };
    }

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
        totalValue: bigint;
    }> {
        let lastErr: any;
        const account = this.account;

        for (const url of this.rpcUrls) {
            const transport = http(url, { timeout: 10000 });
            const client = createPublicClient({ chain: this.chain, transport }) as PublicClient;

            try {
                const sender = account.address;
                const decimals = await this.getMultiSendContractDecimals(client, multiSendContract as Address);
                const { addresses, amounts } = this.prepareMultiSendData(recipients, decimals);

                const totalAmounts = amounts.reduce((sum, a) => sum + a, 0n);

                const data = encodeFunctionData({
                    abi: Const.MULTI_SEND_ABI_CONTRACT as any,
                    functionName: 'multiSend',
                    args: [addresses, amounts]
                });

                const { gas, txValue } = await this.estimateMultiSendGas(client, account, multiSendContract as Address, data, totalAmounts);
                const [nonce, chainId] = await Promise.all([
                    client.getTransactionCount({ address: sender, blockTag: 'pending' }),
                    client.getChainId()
                ]);

                return { client, sender, chainId, nonce, gas, data, account, totalValue: txValue };
            } catch (err: any) {
                lastErr = err;
                logger.error('MULTI_PREP', `❌[PREPARE_FAILED][${url}][MSG:${err?.message || err}]`);
                if (!isEvmNetworkError(err)) throw err;
                logger.warn('MULTI_PREP', '🔄[PREPARE_RETRY][NEXT_PROVIDER]');
            }
        }

        throw new Error(`All RPC providers failed during multi-send preparation: ${lastErr?.message || lastErr}`);
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
        fees: any,
        totalValue: bigint
    ): any {
        const tx: any = {
            account: sender as Hex,
            to: multiSendContract as Address,
            data,
            gas: BigInt(gas),
            nonce,
            chainId,
            value: totalValue,
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

    async multiSend(
        recipients: Recipient[],
        multiSendContract: string,
        currency: string,
        waitForReceipt: boolean = true,
        requestId?: string
    ): Promise<string> {
        const network = this.payway.toUpperCase();
        const prep = await this.prepareCommon(recipients, multiSendContract);
        const { client, sender, chainId, nonce, gas, data, account, totalValue } = prep;

        let fees = await this.buildInitialFees(client);
        const maxAttempts = 4;
        let lastErr: any;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const tx = this.createTransactionObject(sender, multiSendContract, data, gas, nonce, chainId, fees, totalValue);
            const rawTx = await account.signTransaction(tx);
            const rawHash = keccak256(rawTx);
            const reqInfo = requestId ? `[${requestId}]` : '';
            logger.info(network, `🔄${reqInfo}[ATTEMPT ${attempt}/${maxAttempts}][RAW:${rawHash}]`);

            try {
                const res = await this.fanoutSend(rawTx, waitForReceipt);
                if (waitForReceipt) {
                    await this.logSuccessfulTransaction(
                        { txHash: res.txHash, receipt: res.receipt as any, via: res.via },
                        currency,
                        requestId
                    );
                } else {
                    this.logTransactionSubmitted(res.txHash, res.via, requestId);
                    this.waitForReceiptInBackground(res.txHash, res.via, currency, requestId);
                }
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
                    logger.warn(network, `🔄${reqInfo}[REPLACE_RETRY ${attempt + 1}/${maxAttempts}]`);
                    continue;
                }

                // Handle network vs non-network errors
                if (!isEvmNetworkError(err)) {
                    await this.logTransactionError(err, currency, requestId);
                    throw new Error(
                        `Transaction failed for payway = ${this.payway} (multi-send): ${err?.message || err}`,
                    );
                }

                // Final attempt failed
                if (attempt === maxAttempts) {
                    await this.logTransactionError(err, currency, requestId);
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
