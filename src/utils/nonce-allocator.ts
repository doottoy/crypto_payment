import type { Address, PublicClient } from 'viem';

type NonceLease = {
    nonce: number;
    release: (success: boolean) => Promise<void>;
};

type NonceState = {
    nextNonce?: number;
    inFlight: Set<number>;
    needsResync: boolean;
};

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

    async reserveNonce(client: PublicClient, address: Address, chainId: number): Promise<NonceLease> {
        const key = this.key(chainId, address);
        return this.withLock(key, async () => {
            const state = this.states.get(key) || { inFlight: new Set<number>(), needsResync: false };

            if (state.needsResync && state.inFlight.size === 0) {
                state.nextNonce = await client.getTransactionCount({ address, blockTag: 'pending' });
                state.needsResync = false;
            }

            if (state.nextNonce === undefined) {
                state.nextNonce = await client.getTransactionCount({ address, blockTag: 'pending' });
            }

            const nonce = state.nextNonce;
            state.nextNonce += 1;
            state.inFlight.add(nonce);
            this.states.set(key, state);

            return {
                nonce,
                release: (success: boolean) => this.releaseNonce(key, nonce, success)
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
