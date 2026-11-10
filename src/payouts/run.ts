/* External dependencies */
import { AsyncLocalStorage } from 'async_hooks';
import { createHash, randomUUID } from 'crypto';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { scheduleCallback } from './callbacks';
import { redactSecrets } from './serialize';
import { ApiError, toErrorResponse } from '../api/errors';
import { getPayoutStore, type PayoutRecord, type Transition } from './store';
import { IdempotencyConflictError, requestIdRegistry, stableStringify } from '../utils/idempotency';

export interface PayoutJob {
    /** endpoint label, e.g. 'payout/evm'; request_id is unique per endpoint */
    scope: string;
    chain: string;
    payway?: string;
    currency?: string;
    requestId?: string;
    /** raw request data: hashed for the request_id comparison, stored without secrets */
    payload: unknown;
    callbackUrl?: string;
    /** the handler returns right after broadcasting and a background receipt wait reports the outcome */
    settlesInBackground?: boolean;
}

export interface PayoutResult {
    txId: string;
    payoutId: string;
    requestId: string;
    /** answered from the journal: the payout was made by an earlier request with the same request_id */
    replayed: boolean;
}

/* Carries the journal record of the running payout into the background receipt waits the services start */
const payoutContext = new AsyncLocalStorage<{ payoutId: string }>();

function idempotencyWindowStart(): string {
    const hours = Number(process.env.IDEMPOTENCY_TTL_HOURS) || 6;
    return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

export function payloadFingerprint(payload: unknown): string {
    return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function settle(transition: Transition): void {
    const { record, changed } = transition;
    if (!changed || (record.status !== 'succeeded' && record.status !== 'failed')) return;
    logger.info('JOURNAL', `📒[${record.requestId}][${record.scope}][${record.status.toUpperCase()}]${record.txId ? `[HASH:${record.txId}]` : ''}`);
    scheduleCallback(record);
}

function txIdOf(details: unknown): string | undefined {
    const txId = (details as { tx_id?: unknown } | undefined)?.tx_id;
    return typeof txId === 'string' ? txId : undefined;
}

/* Journal bookkeeping after the payout ran must never change its answer: a tx_id lost to a journal error would invite
   a retry, and a retry pays twice */
function safely(action: () => void): void {
    try {
        action();
    } catch (error) {
        logger.error('JOURNAL', `❌[UPDATE_FAILED][MSG:${error instanceof Error ? error.message : String(error)}]`);
    }
}

async function execute(record: PayoutRecord, job: PayoutJob, handler: () => Promise<string>): Promise<PayoutResult> {
    const store = getPayoutStore();
    let txId: string;
    try {
        txId = await payoutContext.run({ payoutId: record.id }, handler);
    } catch (error) {
        safely(() => {
            const { body } = toErrorResponse(error);
            settle(store.markFailed(record.id, body.code, body.error, txIdOf(body.details)));
        });
        throw error;
    }

    safely(() => settle(job.settlesInBackground ? store.markSubmitted(record.id, txId) : store.markSucceeded(record.id, txId)));
    return { txId, payoutId: record.id, requestId: record.requestId, replayed: false };
}

/**
 * Runs one payout through the journal:
 * - every payout gets a record (and a generated request_id when the caller sent none);
 * - a request_id seen on this endpoint within IDEMPOTENCY_TTL_HOURS (default 6) replays the earlier tx_id, joins the
 *   request still in flight, or retries after a failure; a different payload under it is a 409 idempotency_conflict;
 * - a request_id whose earlier attempt was cut by a restart is a 409 outcome_unknown, never a second payout.
 * The journal survives restarts, so a retry after a deploy can no longer pay twice.
 */
export async function runPayout(job: PayoutJob, handler: () => Promise<string>): Promise<PayoutResult> {
    const store = getPayoutStore();
    const fingerprint = payloadFingerprint(job.payload);
    const newRecord = (requestId: string) => store.create({
        scope: job.scope,
        requestId,
        fingerprint,
        chain: job.chain,
        payway: job.payway,
        currency: job.currency,
        request: redactSecrets(job.payload),
        callbackUrl: job.callbackUrl
    });

    const requestId = job.requestId;
    if (!requestId) {
        return execute(newRecord(randomUUID()), job, handler);
    }

    // The in-memory registry joins concurrent requests with the same request_id and payload
    return requestIdRegistry.run(job.scope, requestId, job.payload, async () => {
        const existing = store.findActive(job.scope, requestId, idempotencyWindowStart());
        if (!existing) {
            return execute(newRecord(requestId), job, handler);
        }

        if (existing.fingerprint !== fingerprint) {
            throw new IdempotencyConflictError(job.scope, requestId);
        }

        if ((existing.status === 'succeeded' || existing.status === 'submitted') && existing.txId) {
            logger.info('JOURNAL', `📒[${requestId}][${job.scope}][REPLAY][HASH:${existing.txId}]`);
            return { txId: existing.txId, payoutId: existing.id, requestId, replayed: true };
        }

        if (existing.status === 'failed') {
            return execute(store.restart(existing.id), job, handler);
        }

        const check = existing.txId ? `transaction ${existing.txId}` : 'the sender history';
        throw new ApiError(
            409,
            'outcome_unknown',
            `An earlier attempt with request_id "${requestId}" never finished (the service restarted while it ran). Check ${check} before paying again with a new request_id.`,
            { payout_id: existing.id, tx_id: existing.txId ?? null }
        );
    });
}

/**
 * Called by a background receipt wait (wait_for_receipt: false) once it knows the outcome of the payout it belongs to.
 * Does nothing outside a payout (e.g. in service unit tests).
 */
export function reportPayoutOutcome(outcome: { txId: string } | { error: unknown; txId?: string }): void {
    const context = payoutContext.getStore();
    if (!context) return;

    try {
        const store = getPayoutStore();
        if ('error' in outcome) {
            const { body } = toErrorResponse(outcome.error);
            settle(store.markFailed(context.payoutId, body.code, body.error, outcome.txId ?? txIdOf(body.details)));
        } else {
            settle(store.markSucceeded(context.payoutId, outcome.txId));
        }
    } catch (error) {
        logger.error('JOURNAL', `❌[REPORT_FAILED][MSG:${error instanceof Error ? error.message : String(error)}]`);
    }
}
