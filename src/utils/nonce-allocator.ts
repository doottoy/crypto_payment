/* External dependencies */
import type { Address, PublicClient } from 'viem';

/* Internal dependencies */
import { logger } from './logger';

type NonceLease = {
    nonce: number;
    release: (success: boolean) => Promise<void>;
};

type NonceState = {
    nextNonce?: number;
    inFlight: Set<number>;
    needsResync: boolean;
};

/* Pending nonce of the node, or undefined when a failed read falls back to the cached one */
async function readPendingNonce(
    client: PublicClient,
    address: Address,
    cached: number | undefined,
    fallbackToCache: boolean
): Promise<number | undefined> {
    try {
        return await client.getTransactionCount({ address, blockTag: 'pending' });
    } catch (err: any) {
        if (cached === undefined || !fallbackToCache) throw err;
        // A transient RPC error must not fail a send the cached nonce can serve
        logger.warn('NONCE', `⚠️[PENDING_READ_FAILED][${address}][USING_CACHE:${cached}][MSG:${err?.details || err?.shortMessage || err?.message || err}]`);
        return undefined;
    }
}

/**
 * In-memory nonce allocator for a single process instance
 * Not safe across multiple processes or servers
 */
class InMemoryNonceAllocator {
    private states = new Map<string, NonceState>();
    private locks = new Map<string, Promise<void>>();

    private key(chainId: number, address: Address): string {
        return `${chainId}:${address.toLowerCase()}`;
    }

    private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.locks.get(key) || Promise.resolve();
        let release!: () => void;
        const next = new Promise<void>((resolve) => {
            release = resolve;
        });

        this.locks.set(key, prev.then(() => next));
        await prev;
        try {
            return await fn();
        } finally {
            release();
            if (this.locks.get(key) === next) {
                this.locks.delete(key);
            }
        }
    }

    /**
     * Reserves the larger of the cached next nonce and the pending nonce of the node: a higher pending nonce means the
     * key sent outside this process, a lower one is a lagging node or our own nonces not broadcast yet.
     * After a failed send with nothing in flight (resync) the pending nonce wins even when lower, closing unsent gaps.
     * A failed pending read uses the cache when there is one and `fallbackToCache` allows it, otherwise it throws.
     */
    async reserveNonce(client: PublicClient, address: Address, chainId: number, fallbackToCache = true): Promise<NonceLease> {
        const key = this.key(chainId, address);
        return this.withLock(key, async () => {
            const state = this.states.get(key) || { inFlight: new Set<number>(), needsResync: false };
            const pending = await readPendingNonce(client, address, state.nextNonce, fallbackToCache);

            if (pending !== undefined && state.needsResync && state.inFlight.size === 0) {
                state.nextNonce = pending;
                state.needsResync = false;
            } else if (pending !== undefined) {
                state.nextNonce = Math.max(state.nextNonce ?? pending, pending);
            }

            // Set: either just read or the cache the failed read fell back to
            const nonce = state.nextNonce as number;
            state.nextNonce = nonce + 1;
            state.inFlight.add(nonce);
            this.states.set(key, state);

            let released = false;
            return {
                nonce,
                release: async (success: boolean) => {
                    // Only the first call counts: a repeated one must not drop the same nonce leased again since
                    if (released) return;
                    released = true;
                    await this.releaseNonce(key, nonce, success);
                }
            };
        });
    }

    async markResync(address: Address, chainId: number): Promise<void> {
        const key = this.key(chainId, address);
        return this.withLock(key, async () => {
            const state = this.states.get(key);
            if (!state) return;
            state.needsResync = true;
            this.states.set(key, state);
        });
    }

    private async releaseNonce(key: string, nonce: number, success: boolean): Promise<void> {
        return this.withLock(key, async () => {
            const state = this.states.get(key);
            if (!state) return;

            state.inFlight.delete(nonce);
            if (!success) {
                state.needsResync = true;
            }

            if (state.inFlight.size === 0 && state.nextNonce === undefined) {
                this.states.delete(key);
            } else {
                this.states.set(key, state);
            }
        });
    }
}

export const nonceAllocator = new InMemoryNonceAllocator();
export type { NonceLease };
