/* External dependencies */
import net from 'net';
import dns from 'dns/promises';
import { createHmac } from 'crypto';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { getPayoutStore, type PayoutRecord } from './store';
import { toApiPayout } from './serialize';

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [2000, 10000];
const TIMEOUT_MS = 10000;

/* Loopback, private, link-local and carrier-grade NAT ranges: a callback must not reach the service's own network */
const PRIVATE_RANGES = new net.BlockList();
for (const [address, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]
] as const) {
    PRIVATE_RANGES.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) {
    PRIVATE_RANGES.addSubnet(address, prefix, 'ipv6');
}

class UndeliverableCallbackError extends Error {}

export function isPrivateAddress(ip: string): boolean {
    const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return PRIVATE_RANGES.check(mapped[1], 'ipv4');
    return PRIVATE_RANGES.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');
}

async function assertDeliverable(rawUrl: string): Promise<void> {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new UndeliverableCallbackError(`unsupported protocol ${url.protocol}`);
    }
    if (process.env.CALLBACK_ALLOW_PRIVATE === 'true') return;

    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
    if (addresses.some(isPrivateAddress)) {
        throw new UndeliverableCallbackError(`${host} resolves to a private address (set CALLBACK_ALLOW_PRIVATE=true to allow)`);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function deliver(payoutId: string): Promise<void> {
    const store = getPayoutStore();
    let lastError = '';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const record = store.get(payoutId);
        if (!record?.callback) return;

        try {
            await assertDeliverable(record.callback.url);
            const body = JSON.stringify({ event: `payout.${record.status}`, payout: toApiPayout(record) });
            const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'crypto-payment-callbacks' };
            if (process.env.CALLBACK_SECRET) {
                headers['X-Signature'] = `sha256=${createHmac('sha256', process.env.CALLBACK_SECRET).update(body).digest('hex')}`;
            }

            // Redirects are not followed: they could point the request somewhere assertDeliverable never checked
            const response = await fetch(record.callback.url, {
                method: 'POST',
                headers,
                body,
                redirect: 'manual',
                signal: AbortSignal.timeout(TIMEOUT_MS)
            });
            if (response.ok) {
                store.setCallback(payoutId, { url: record.callback.url, status: 'delivered', attempts: attempt });
                logger.info('CALLBACK', `📬[${record.requestId}][DELIVERED][ATTEMPT:${attempt}][HTTP:${response.status}]`);
                return;
            }
            lastError = `HTTP ${response.status}`;
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            if (error instanceof UndeliverableCallbackError) attempt = MAX_ATTEMPTS;
        }

        const final = attempt >= MAX_ATTEMPTS;
        store.setCallback(payoutId, { url: record.callback.url, status: final ? 'failed' : 'pending', attempts: attempt, lastError });
        logger.warn('CALLBACK', `⚠️[${record.requestId}][${final ? 'GAVE_UP' : 'RETRY'}][ATTEMPT:${attempt}][MSG:${lastError}]`);
        if (final) return;
        await sleep(RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]);
    }
}

/** Posts the final state of a payout to its callback_url in the background; never throws */
export function scheduleCallback(record: PayoutRecord): void {
    if (!record.callback) return;
    void deliver(record.id).catch((error) => {
        logger.error('CALLBACK', `❌[${record.requestId}][MSG:${error instanceof Error ? error.message : String(error)}]`);
    });
}
