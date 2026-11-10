/* External dependencies */
import { z } from 'zod';
import { parseUnits } from 'viem';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { modules } from '../utils/modules';
import { toPlainDecimal } from '../api/schemas';
import { getBalance, type Balance, type BalanceQuery } from '../services/balance.service';

const watchEntrySchema = z.object({
    payway: z.string().trim().min(1),
    address: z.string().trim().min(1).optional(),
    token: z.string().trim().min(1).optional(),
    min: z.union([z.string(), z.number()]).transform(toPlainDecimal).refine((v) => /^\d*\.?\d+$/.test(v), 'must be a non-negative number'),
    label: z.string().trim().optional()
});

export type WatchEntry = z.output<typeof watchEntrySchema>;

export interface WatchState {
    entry: WatchEntry;
    low: boolean;
    balance?: Balance;
    checkedAt?: string;
    error?: string;
}

function walletName(entry: WatchEntry): string {
    const where = entry.address ?? 'node wallet';
    return entry.label ? `${entry.label} (${where})` : where;
}

export function formatLowBalance(state: WatchState): string {
    const { entry, balance } = state;
    const unit = balance?.symbol ?? entry.token ?? '';
    return `⚠️ Type: Low balance
🌐 Blockchain: ${entry.payway.toUpperCase()}
👤 Wallet: ${walletName(entry)}
💰 Balance: ${balance?.balance} ${unit}
📉 Minimum: ${entry.min} ${unit}`;
}

export function formatBalanceRestored(state: WatchState): string {
    const { entry, balance } = state;
    const unit = balance?.symbol ?? entry.token ?? '';
    return `✅ Type: Balance restored
🌐 Blockchain: ${entry.payway.toUpperCase()}
👤 Wallet: ${walletName(entry)}
💰 Balance: ${balance?.balance} ${unit}`;
}

/**
 * Checks a fixed list of wallets on an interval and alerts once when one drops below its minimum and once when it is
 * back above it, so a test wallet running dry is noticed before the payouts start failing.
 */
export class BalanceWatcher {
    private readonly states: WatchState[];
    private timer?: NodeJS.Timeout;

    constructor(
        entries: WatchEntry[],
        private readonly fetchBalance: (query: BalanceQuery) => Promise<Balance> = getBalance,
        private readonly notify: (message: string) => Promise<void> = (message) => modules.sendMessageToTelegram(message),
        readonly intervalMinutes = 15
    ) {
        this.states = entries.map((entry) => ({ entry, low: false }));
    }

    async checkAll(): Promise<void> {
        for (const state of this.states) {
            const { entry } = state;
            try {
                const balance = await this.fetchBalance({ payway: entry.payway, address: entry.address, token: entry.token });
                const below = BigInt(balance.raw) < parseUnits(entry.min, balance.decimals);
                state.balance = balance;
                state.checkedAt = new Date().toISOString();
                state.error = undefined;

                if (below && !state.low) {
                    state.low = true;
                    logger.warn('BALANCE_WATCH', `⚠️[LOW][${entry.payway}][${walletName(entry)}][${balance.balance} < ${entry.min}]`);
                    await this.notify(formatLowBalance(state));
                } else if (!below && state.low) {
                    state.low = false;
                    logger.info('BALANCE_WATCH', `✅[RESTORED][${entry.payway}][${walletName(entry)}][${balance.balance}]`);
                    await this.notify(formatBalanceRestored(state));
                }
            } catch (error) {
                // A failed read is not a low balance: keep the last state, log, try again next round
                state.error = error instanceof Error ? error.message : String(error);
                logger.warn('BALANCE_WATCH', `⚠️[CHECK_FAILED][${entry.payway}][${walletName(entry)}][MSG:${state.error}]`);
            }
        }
    }

    start(): void {
        const run = () => { void this.checkAll(); };
        run();
        this.timer = setInterval(run, this.intervalMinutes * 60 * 1000);
        this.timer.unref();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
    }

    status() {
        return this.states.map((state) => ({
            payway: state.entry.payway,
            address: state.entry.address ?? null,
            token: state.entry.token ?? null,
            label: state.entry.label ?? null,
            min: state.entry.min,
            balance: state.balance?.balance ?? null,
            symbol: state.balance?.symbol ?? null,
            low: state.low,
            checked_at: state.checkedAt ?? null,
            error: state.error ?? null
        }));
    }
}

let active: BalanceWatcher | undefined;

export function activeBalanceWatcher(): BalanceWatcher | undefined {
    return active;
}

/**
 * BALANCE_WATCH='[{"payway":"base_eth","address":"0x...","min":"0.05","label":"QA wallet"}]'
 * BALANCE_WATCH_INTERVAL_MINUTES=15 (default). A broken config is logged and the watcher stays off; it never stops
 * the service from starting.
 */
export function startBalanceWatcherFromEnv(): BalanceWatcher | undefined {
    const raw = process.env.BALANCE_WATCH;
    if (!raw || !raw.trim()) return undefined;

    let entries: WatchEntry[];
    try {
        entries = z.array(watchEntrySchema).min(1).parse(JSON.parse(raw));
    } catch (error) {
        logger.error('BALANCE_WATCH', `❌[INVALID_CONFIG][WATCHER_OFF][MSG:${error instanceof Error ? error.message : String(error)}]`);
        return undefined;
    }

    const minutes = Number(process.env.BALANCE_WATCH_INTERVAL_MINUTES) || 15;
    active = new BalanceWatcher(entries, getBalance, (message) => modules.sendMessageToTelegram(message), minutes);
    active.start();
    logger.info('BALANCE_WATCH', `👀[STARTED][WALLETS:${entries.length}][EVERY:${minutes}m]`);
    return active;
}
