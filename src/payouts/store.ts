/* External dependencies */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

/* Internal dependencies */
import { logger } from '../utils/logger';

/**
 * pending   - the request is being processed
 * submitted - broadcast, the outcome is decided by a background receipt wait (wait_for_receipt: false)
 * succeeded - final: the payout happened
 * failed    - final: the payout did not happen (a retry with the same request_id is allowed)
 * unknown   - the service restarted while the payout was pending: it may or may not have been broadcast
 */
export type PayoutStatus = 'pending' | 'submitted' | 'succeeded' | 'failed' | 'unknown';

export interface PayoutCallback {
    url: string;
    status: 'pending' | 'delivered' | 'failed';
    attempts: number;
    lastError?: string;
}

export interface PayoutRecord {
    id: string;
    scope: string;
    requestId: string;
    /** sha256 of the request payload, compared on request_id reuse */
    fingerprint: string;
    chain: string;
    payway?: string;
    currency?: string;
    status: PayoutStatus;
    txId?: string;
    error?: { code: string; message: string };
    /** the request payload without private keys */
    request: unknown;
    callback?: PayoutCallback;
    attempts: number;
    createdAt: string;
    /** start of the latest attempt, the request_id reuse window counts from it */
    startedAt: string;
    updatedAt: string;
    completedAt?: string;
}

export interface NewPayout {
    scope: string;
    requestId: string;
    fingerprint: string;
    chain: string;
    payway?: string;
    currency?: string;
    request: unknown;
    callbackUrl?: string;
}

export interface PayoutFilter {
    status?: PayoutStatus;
    chain?: string;
    scope?: string;
    requestId?: string;
    /** only records created strictly before this ISO timestamp (pagination cursor) */
    before?: string;
    limit?: number;
}

export interface Transition {
    record: PayoutRecord;
    /** false when the record was already past the states the transition starts from */
    changed: boolean;
}

const FINAL_STATUSES: readonly PayoutStatus[] = ['succeeded', 'failed'];
const COMPACT_MIN_LINES = 1000;

function nowIso(): string {
    return new Date().toISOString();
}

/**
 * Payout journal kept in memory and persisted as an append-only JSON Lines file: every change appends the full record,
 * the last line of a record wins on load. Appends are synchronous, so a check followed by a write never interleaves
 * with another request. The file is compacted once superseded lines outnumber live records, and final records older
 * than the retention window are dropped. Without a file (tests, DATA_DIR=:memory:) nothing is persisted.
 */
export class PayoutStore {
    private readonly records = new Map<string, PayoutRecord>();
    private readonly byRequest = new Map<string, string[]>();
    private lines = 0;

    constructor(private readonly file: string | null, private readonly retentionDays = 30) {
        if (file) this.load(file);
    }

    static open(dataDir: string, retentionDays: number): PayoutStore {
        if (dataDir === ':memory:') return new PayoutStore(null, retentionDays);
        return new PayoutStore(path.join(dataDir, 'payouts.jsonl'), retentionDays);
    }

    private requestKey(scope: string, requestId: string): string {
        return `${scope}\u0000${requestId}`;
    }

    private index(record: PayoutRecord): void {
        const key = this.requestKey(record.scope, record.requestId);
        const ids = this.byRequest.get(key) ?? [];
        if (!ids.includes(record.id)) ids.push(record.id);
        this.byRequest.set(key, ids);
    }

    private load(file: string): void {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (fs.existsSync(file)) {
            for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
                if (!line.trim()) continue;
                try {
                    const record = JSON.parse(line) as PayoutRecord;
                    this.records.set(record.id, record);
                    this.index(record);
                    this.lines += 1;
                } catch {
                    // a torn last line after a crash: the previous snapshot of that record stays
                    logger.warn('JOURNAL', '⚠️[SKIPPED_UNREADABLE_LINE]');
                }
            }
        }

        // Pending records belong to requests that died with the previous process
        let interrupted = 0;
        for (const record of this.records.values()) {
            if (record.status !== 'pending') continue;
            this.write({
                ...record,
                status: 'unknown',
                error: { code: 'interrupted', message: 'The service restarted before this payout finished; it may or may not have been broadcast' },
                updatedAt: nowIso()
            });
            interrupted += 1;
        }
        if (interrupted) logger.warn('JOURNAL', `⚠️[INTERRUPTED_PAYOUTS:${interrupted}][STATUS:unknown]`);

        this.prune();
        logger.info('JOURNAL', `📒[LOADED][RECORDS:${this.records.size}][FILE:${file}]`);
    }

    /**
     * The journal must never stop a payout: when the file cannot be written (disk full, volume permissions) the
     * record stays in memory and the failure is logged, the payout goes on as it would have without a journal.
     */
    private write(record: PayoutRecord): PayoutRecord {
        this.records.set(record.id, record);
        this.index(record);
        if (this.file) {
            try {
                fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`);
                this.lines += 1;
                if (this.lines >= COMPACT_MIN_LINES && this.lines > this.records.size * 2) this.compact();
                this.writeFailed = false;
            } catch (error) {
                if (!this.writeFailed) {
                    logger.error('JOURNAL', `❌[WRITE_FAILED][KEEPING_IN_MEMORY][MSG:${error instanceof Error ? error.message : String(error)}]`);
                }
                this.writeFailed = true;
            }
        }
        return record;
    }

    private writeFailed = false;

    /** Rewrites the file with one line per live record (write to a temp file, then rename) */
    compact(): void {
        if (!this.file) return;
        try {
            const tmp = `${this.file}.tmp`;
            const content = [...this.records.values()].map((r) => JSON.stringify(r)).join('\n');
            fs.writeFileSync(tmp, content ? `${content}\n` : '');
            fs.renameSync(tmp, this.file);
            this.lines = this.records.size;
        } catch (error) {
            logger.error('JOURNAL', `❌[COMPACT_FAILED][MSG:${error instanceof Error ? error.message : String(error)}]`);
        }
    }

    /** Drops final records completed before the retention window, then compacts */
    prune(now: number = Date.now()): number {
        const cutoff = new Date(now - this.retentionDays * 24 * 60 * 60 * 1000).toISOString();
        let dropped = 0;
        for (const record of [...this.records.values()]) {
            if (!FINAL_STATUSES.includes(record.status) || (record.completedAt ?? record.updatedAt) >= cutoff) continue;
            this.records.delete(record.id);
            const key = this.requestKey(record.scope, record.requestId);
            const ids = (this.byRequest.get(key) ?? []).filter((id) => id !== record.id);
            if (ids.length) this.byRequest.set(key, ids); else this.byRequest.delete(key);
            dropped += 1;
        }
        if (dropped || this.lines > this.records.size) this.compact();
        return dropped;
    }

    create(input: NewPayout): PayoutRecord {
        const now = nowIso();
        return this.write({
            id: randomUUID(),
            scope: input.scope,
            requestId: input.requestId,
            fingerprint: input.fingerprint,
            chain: input.chain,
            payway: input.payway,
            currency: input.currency,
            status: 'pending',
            request: input.request,
            callback: input.callbackUrl ? { url: input.callbackUrl, status: 'pending', attempts: 0 } : undefined,
            attempts: 1,
            createdAt: now,
            startedAt: now,
            updatedAt: now
        });
    }

    get(id: string): PayoutRecord | undefined {
        return this.records.get(id);
    }

    /** By payout id, else the latest record with this request_id on any endpoint */
    findLatest(idOrRequestId: string): PayoutRecord | undefined {
        const byId = this.records.get(idOrRequestId);
        if (byId) return byId;
        return this.list({ requestId: idOrRequestId, limit: 1 })[0];
    }

    /** The latest record of this endpoint and request_id whose current attempt started at or after `since` */
    findActive(scope: string, requestId: string, since: string): PayoutRecord | undefined {
        const ids = this.byRequest.get(this.requestKey(scope, requestId)) ?? [];
        return ids
            .map((id) => this.records.get(id))
            .filter((r): r is PayoutRecord => Boolean(r) && (r as PayoutRecord).startedAt >= since)
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    }

    private transition(id: string, from: readonly PayoutStatus[], patch: Partial<PayoutRecord>): Transition {
        const record = this.records.get(id);
        if (!record) throw new Error(`Unknown payout ${id}`);
        if (!from.includes(record.status)) return { record, changed: false };
        return { record: this.write({ ...record, ...patch, updatedAt: nowIso() }), changed: true };
    }

    /** A failed payout tried again under the same request_id */
    restart(id: string): PayoutRecord {
        const record = this.records.get(id);
        if (!record) throw new Error(`Unknown payout ${id}`);
        const now = nowIso();
        return this.write({
            ...record,
            status: 'pending',
            txId: undefined,
            error: undefined,
            completedAt: undefined,
            callback: record.callback ? { ...record.callback, status: 'pending', attempts: 0, lastError: undefined } : undefined,
            attempts: record.attempts + 1,
            startedAt: now,
            updatedAt: now
        });
    }

    markSubmitted(id: string, txId: string): Transition {
        return this.transition(id, ['pending'], { status: 'submitted', txId });
    }

    markSucceeded(id: string, txId: string): Transition {
        return this.transition(id, ['pending', 'submitted', 'unknown'], {
            status: 'succeeded',
            txId,
            error: undefined,
            completedAt: nowIso()
        });
    }

    markFailed(id: string, code: string, message: string, txId?: string): Transition {
        const current = this.records.get(id);
        return this.transition(id, ['pending', 'submitted'], {
            status: 'failed',
            txId: txId ?? current?.txId,
            error: { code, message },
            completedAt: nowIso()
        });
    }

    setCallback(id: string, callback: PayoutCallback): void {
        const record = this.records.get(id);
        if (!record) return;
        this.write({ ...record, callback, updatedAt: nowIso() });
    }

    list(filter: PayoutFilter = {}): PayoutRecord[] {
        const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
        return [...this.records.values()]
            .filter((r) => (filter.status ? r.status === filter.status : true))
            .filter((r) => (filter.chain ? r.chain === filter.chain : true))
            .filter((r) => (filter.scope ? r.scope === filter.scope : true))
            .filter((r) => (filter.requestId ? r.requestId === filter.requestId : true))
            .filter((r) => (filter.before ? r.createdAt < filter.before : true))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
            .slice(0, limit);
    }

    get size(): number {
        return this.records.size;
    }
}

let instance: PayoutStore | undefined;

/**
 * The process-wide journal, opened on first use from DATA_DIR (default ./data). A journal that cannot be opened is
 * logged and replaced by an in-memory one: payouts keep working, only the history does not survive a restart.
 */
export function getPayoutStore(): PayoutStore {
    if (!instance) {
        const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
        const retention = Number(process.env.PAYOUT_RETENTION_DAYS) || 30;
        try {
            instance = PayoutStore.open(dataDir, retention);
        } catch (error) {
            logger.error('JOURNAL', `❌[OPEN_FAILED][DIR:${dataDir}][IN_MEMORY_ONLY][MSG:${error instanceof Error ? error.message : String(error)}]`);
            instance = new PayoutStore(null, retention);
        }
    }
    return instance;
}

export function setPayoutStore(store: PayoutStore | undefined): void {
    instance = store;
}
