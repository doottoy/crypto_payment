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
