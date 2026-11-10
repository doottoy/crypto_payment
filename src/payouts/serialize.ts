/* Internal dependencies */
import type { PayoutRecord } from './store';

const SECRET_KEY = /private|secret|seed|mnemonic|password/i;

/** Deep copy of a request payload without private keys or other secrets, safe to store and to return */
export function redactSecrets(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redactSecrets);
    if (value === null || typeof value !== 'object') return value;

    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_KEY.test(key)) continue;
        copy[key] = redactSecrets(entry);
    }
    return copy;
}

/** The public (snake_case) shape of a journal record, used by GET /payouts and callbacks */
export function toApiPayout(record: PayoutRecord) {
    return {
        id: record.id,
        request_id: record.requestId,
        endpoint: record.scope,
        chain: record.chain,
        payway: record.payway ?? null,
        currency: record.currency ?? null,
        status: record.status,
        tx_id: record.txId ?? null,
        error: record.error ?? null,
        callback: record.callback
            ? { url: record.callback.url, status: record.callback.status, attempts: record.callback.attempts, last_error: record.callback.lastError ?? null }
            : null,
        attempts: record.attempts,
        request: record.request,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
        completed_at: record.completedAt ?? null
    };
}
