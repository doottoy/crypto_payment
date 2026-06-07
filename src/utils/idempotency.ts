type CacheEntry<T> = {
    fingerprint: string;
    createdAt: number;
    promise: Promise<T>;
};

export class IdempotencyConflictError extends Error {
    readonly statusCode = 409;

    constructor(scope: string, requestId: string) {
        super(`request_id "${requestId}" is already used for a different payload on ${scope}`);
        this.name = 'IdempotencyConflictError';
    }
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right));

    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`;
}

export class RequestIdRegistry {
    private readonly entries = new Map<string, CacheEntry<unknown>>();

    constructor(
        private readonly ttlMs: number = 6 * 60 * 60 * 1000,
        private readonly maxEntries: number = 1000
    ) { }

    async run<T>(
        scope: string,
        requestId: string | undefined,
        payload: unknown,
        handler: () => Promise<T>
    ): Promise<T> {
        const normalizedRequestId = requestId?.trim();
        if (!normalizedRequestId) {
            return handler();
        }

        this.prune();

        const key = `${scope}:${normalizedRequestId}`;
        const fingerprint = stableStringify(payload);
        const existing = this.entries.get(key) as CacheEntry<T> | undefined;

        if (existing) {
            if (existing.fingerprint !== fingerprint) {
                throw new IdempotencyConflictError(scope, normalizedRequestId);
            }

            return existing.promise;
        }

        const entry: CacheEntry<T> = {
            fingerprint,
            createdAt: Date.now(),
            promise: Promise.resolve().then(handler)
        };

        entry.promise = entry.promise.catch((error) => {
            this.entries.delete(key);
            throw error;
        });

        this.entries.set(key, entry);

        return entry.promise;
    }

    private prune(): void {
        const now = Date.now();

        for (const [key, entry] of this.entries.entries()) {
            if (now - entry.createdAt > this.ttlMs) {
                this.entries.delete(key);
            }
        }

        if (this.entries.size <= this.maxEntries) {
            return;
        }

        const oldestEntries = [...this.entries.entries()]
            .sort((left, right) => left[1].createdAt - right[1].createdAt)
            .slice(0, this.entries.size - this.maxEntries);

        for (const [key] of oldestEntries) {
            this.entries.delete(key);
        }
    }
}

export const requestIdRegistry = new RequestIdRegistry();