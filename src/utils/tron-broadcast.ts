/* Internal dependencies */
import { logger } from './logger';

/* Constants */
import { Const } from '../constants/const';

interface TronBroadcastVerdict {
    accepted: boolean;
    txId: string;
    code: string;
    message: string;
}

/**
 * TronWeb returns { result: false, code, message } when the node rejects a broadcast, while
 * the txid is still present in the response (it is computed locally from the signed
 * transaction). Trusting that txid produces a "ghost" transaction that never reached the
 * chain, so the broadcast result must be verified before the txid is returned to the caller.
 */
export function parseTronBroadcastResult(tronWeb: any, result: any): TronBroadcastVerdict {
    const txId = typeof result === 'string'
        ? result
        : result?.txid || result?.transaction?.txID || result?.transaction?.txId || '';

    const rejected = Boolean(result) && typeof result === 'object' && 'result' in result && result.result !== true;

    if (!rejected) {
        return { accepted: true, txId: txId || String(result), code: '', message: '' };
    }

    // The rejection message comes hex-encoded from the node
    let message = '';
    try {
        message = result.message ? tronWeb.toUtf8(result.message) : '';
    } catch {
        message = String(result.message ?? '');
    }

    return {
        accepted: false,
        txId,
        code: result.code ? String(result.code) : 'UNKNOWN_REJECTION',
        message
    };
}

/**
 * Broadcasts a Tron transaction and verifies the node actually accepted it, retrying
 * transient rejections. The `send` callback builds a fresh transaction on every attempt
 * (new ref block + expiration) and a rejected transaction never entered the mempool,
 * so retrying can not produce a duplicate transfer.
 * @param tronWeb - initialized TronWeb instance (used to decode rejection messages)
 * @param network - payway label for logging
 * @param send - callback performing the actual TronWeb send
 * @returns txid of the accepted transaction
 */
export async function sendTronTransactionVerified(tronWeb: any, network: string, send: () => Promise<any>): Promise<string> {
    let lastRejection = 'UNKNOWN_REJECTION';

    for (let attempt = 1; attempt <= Const.TRON_BROADCAST_MAX_ATTEMPTS; attempt++) {
        const verdict = parseTronBroadcastResult(tronWeb, await send());

        if (verdict.accepted) {
            return verdict.txId;
        }

        // The node already knows this transaction - it is effectively broadcast, safe to return
        if (verdict.code === 'DUP_TRANSACTION' && verdict.txId) {
            return verdict.txId;
        }

        lastRejection = `${verdict.code} ${verdict.message}`.trim();
        logger.warn(network, `[BROADCAST-REJECTED][attempt ${attempt}/${Const.TRON_BROADCAST_MAX_ATTEMPTS}][${lastRejection}]`);

        if (!Const.TRON_BROADCAST_RETRYABLE_CODES.includes(verdict.code)) {
            break;
        }

        if (attempt < Const.TRON_BROADCAST_MAX_ATTEMPTS) {
            await new Promise((resolve) => { setTimeout(resolve, Const.TRON_BROADCAST_RETRY_DELAY_MS); });
        }
    }

    throw new Error(`Tron broadcast rejected by node: ${lastRejection}`);
}

/**
 * The transaction is in a block but its contract execution failed (REVERT, OUT_OF_ENERGY, ...): the fee is spent,
 * nothing was transferred. The verdict is final.
 */
export class TronExecutionFailedError extends Error {
    readonly shortMessage: string;

    constructor(
        readonly txId: string,
        readonly result: string,
        readonly reason: string,
        readonly blockNumber?: number
    ) {
        const why = reason ? `${result}: ${reason}` : result;
        super(`Tron transaction ${txId} failed on-chain (${why}), funds were not transferred`);
        this.name = 'TronExecutionFailedError';
        this.shortMessage = `Transaction failed on-chain (${why}), funds were not transferred`;
    }
}

/** No block included the transaction within the wait. Tron transactions expire about a minute after they are built. */
export class TronConfirmationTimeoutError extends Error {
    constructor(readonly txId: string, readonly waitedMs: number) {
        super(`Tron transaction ${txId} was not found in a block after ${Math.round(waitedMs / 1000)}s`);
        this.name = 'TronConfirmationTimeoutError';
    }
}

function decodeTronMessage(tronWeb: any, hex: unknown): string {
    if (typeof hex !== 'string' || !hex) return '';
    try {
        return tronWeb.toUtf8(hex);
    } catch {
        return hex;
    }
}

/**
 * A node accepting a broadcast says nothing about the execution: a TRC20 transfer can still run out of energy or
 * revert in the block. Polls the fullnode until the transaction is in a block, then checks its result.
 * - contract calls: receipt.result must be SUCCESS (a failure also sets result: 'FAILED' and a hex resMessage);
 * - native TRX transfers carry no receipt.result, inclusion is the success.
 * The node answers {} while the transaction is not in a block yet.
 */
export async function waitForTronExecution(
    tronWeb: any,
    network: string,
    txId: string,
    options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<{ blockNumber: number; result: string }> {
    const timeoutMs = options.timeoutMs ?? Const.TRON_CONFIRM_TIMEOUT_MS;
    const intervalMs = options.intervalMs ?? Const.TRON_CONFIRM_POLL_MS;
    const started = Date.now();

    for (;;) {
        let info: any;
        try {
            info = await tronWeb.trx.getUnconfirmedTransactionInfo(txId);
        } catch (error: any) {
            // A flaky read is not a verdict: keep polling until the deadline
            logger.warn(network, `⚠️[TX_INFO_READ_FAILED][HASH:${txId}][MSG:${error?.message || String(error)}]`);
        }

        if (info && typeof info === 'object' && info.blockNumber !== undefined) {
            const receiptResult: string | undefined = info.receipt?.result;
            if (info.result === 'FAILED' || (receiptResult !== undefined && receiptResult !== 'SUCCESS')) {
                throw new TronExecutionFailedError(txId, receiptResult || 'FAILED', decodeTronMessage(tronWeb, info.resMessage), info.blockNumber);
            }
            logger.info(network, `⛓️[IN_BLOCK:${info.blockNumber}][RESULT:${receiptResult || 'SUCCESS'}][HASH:${txId}]`);
            return { blockNumber: info.blockNumber, result: receiptResult || 'SUCCESS' };
        }

        const waited = Date.now() - started;
        if (waited >= timeoutMs) throw new TronConfirmationTimeoutError(txId, waited);
        await new Promise((resolve) => { setTimeout(resolve, Math.min(intervalMs, timeoutMs - waited)); });
    }
}
