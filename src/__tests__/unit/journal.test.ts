import 'mocha';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { expect } from 'chai';
import { AddressInfo } from 'net';
import { createServer, type Server } from 'http';

import { ApiError } from '../../api/errors';
import { isPrivateAddress } from '../../payouts/callbacks';
import { getPayoutStore, PayoutStore, setPayoutStore, type PayoutRecord } from '../../payouts/store';
import { payloadFingerprint, reportPayoutOutcome, runPayout } from '../../payouts/run';

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (predicate()) return resolve();
            if (Date.now() - started > timeoutMs) return reject(new Error('condition not met in time'));
            setTimeout(tick, 10);
        };
        tick();
    });
}

let uniq = 0;
const nextRequestId = () => `test-${Date.now()}-${uniq++}`;

describe('PayoutStore', () => {
    let dir: string;
    let file: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payout-journal-'));
        file = path.join(dir, 'payouts.jsonl');
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const newPayout = (requestId = 'r1') => ({
        scope: 'payout/evm',
        requestId,
        fingerprint: 'f',
        chain: 'evm',
        request: { amount: '1' }
    });

    it('survives a restart with the latest state of every record', () => {
        const store = new PayoutStore(file);
        const record = store.create(newPayout());
        store.markSubmitted(record.id, '0xabc');
        store.markSucceeded(record.id, '0xabc');

        const reopened = new PayoutStore(file);

        expect(reopened.get(record.id)).to.deep.include({ status: 'succeeded', txId: '0xabc' });
    });

    it('marks payouts cut by a restart as unknown', () => {
        const store = new PayoutStore(file);
        const record = store.create(newPayout());

        const reopened = new PayoutStore(file);

        expect(reopened.get(record.id)?.status).to.equal('unknown');
        expect(reopened.get(record.id)?.error?.code).to.equal('interrupted');
    });

    it('skips a torn last line instead of failing to start', () => {
        const store = new PayoutStore(file);
        const record = store.create(newPayout());
        store.markSucceeded(record.id, '0xabc');
        fs.appendFileSync(file, '{"id":"half-writ');

        const reopened = new PayoutStore(file);

        expect(reopened.get(record.id)?.status).to.equal('succeeded');
    });

    it('drops final records older than the retention window and compacts the file', () => {
        const store = new PayoutStore(file, 30);
        const old = store.create(newPayout('old'));
        store.markSucceeded(old.id, '0x1');
        const recent = store.create(newPayout('recent'));
        store.markSucceeded(recent.id, '0x2');
        const pending = store.create(newPayout('pending'));

        const dropped = store.prune(Date.now() + 31 * 24 * 60 * 60 * 1000);

        expect(dropped).to.equal(2);
        expect(store.get(pending.id)).to.not.equal(undefined);
        expect(fs.readFileSync(file, 'utf8').trim().split('\n')).to.have.length(1);
    });

    it('keeps working in memory when the file cannot be written', () => {
        const store = new PayoutStore(file);
        store.create(newPayout('before'));
        fs.chmodSync(file, 0o444);

        const record = store.create(newPayout('after'));
        store.markSucceeded(record.id, '0xabc');

        expect(store.get(record.id)?.status).to.equal('succeeded');
        fs.chmodSync(file, 0o644);
    });

    it('falls back to an in-memory journal when DATA_DIR cannot be used', () => {
        const blocker = path.join(dir, 'not-a-dir');
        fs.writeFileSync(blocker, '');
        const previous = process.env.DATA_DIR;
        process.env.DATA_DIR = path.join(blocker, 'journal');
        setPayoutStore(undefined);

        try {
            const store = getPayoutStore();
            const record = store.create(newPayout());
            expect(store.get(record.id)).to.not.equal(undefined);
        } finally {
            process.env.DATA_DIR = previous;
            setPayoutStore(undefined);
        }
    });

    it('keeps final states final', () => {
        const store = new PayoutStore(null);
        const record = store.create(newPayout());
        store.markSucceeded(record.id, '0xabc');

        expect(store.markFailed(record.id, 'late', 'late failure').changed).to.equal(false);
        expect(store.markSubmitted(record.id, '0xdef').changed).to.equal(false);
        expect(store.get(record.id)?.status).to.equal('succeeded');
    });

    it('lists newest first with filters and a cursor', () => {
        const store = new PayoutStore(null);
        const first = store.create({ ...newPayout('a'), chain: 'ltc' });
        const second = store.create({ ...newPayout('b'), chain: 'evm' });
        // equal timestamps within one millisecond are ordered by id, so force distinct ones
        (store.get(first.id) as PayoutRecord).createdAt = '2026-01-01T00:00:00.000Z';
        (store.get(second.id) as PayoutRecord).createdAt = '2026-01-02T00:00:00.000Z';

        expect(store.list().map((r) => r.requestId)).to.deep.equal(['b', 'a']);
        expect(store.list({ chain: 'ltc' }).map((r) => r.requestId)).to.deep.equal(['a']);
        expect(store.list({ before: '2026-01-02T00:00:00.000Z' }).map((r) => r.requestId)).to.deep.equal(['a']);
    });
});

describe('runPayout', () => {
    let store: PayoutStore;
    let callbacks: Server;
    let callbackUrl: string;
    let received: any[];

    before(async () => {
        received = [];
        callbacks = createServer((req, res) => {
            let raw = '';
            req.on('data', (chunk) => { raw += chunk; });
            req.on('end', () => {
                received.push({ headers: req.headers, body: JSON.parse(raw) });
                res.writeHead(204).end();
            });
        }).listen(0);
        await new Promise((resolve) => callbacks.once('listening', resolve));
        callbackUrl = `http://127.0.0.1:${(callbacks.address() as AddressInfo).port}/hook`;
    });

    after(async () => {
        await new Promise((resolve) => callbacks.close(resolve));
        setPayoutStore(undefined);
    });

    beforeEach(() => {
        store = new PayoutStore(null);
        setPayoutStore(store);
        received = [];
        process.env.CALLBACK_ALLOW_PRIVATE = 'true';
        delete process.env.CALLBACK_SECRET;
    });

    afterEach(() => {
        delete process.env.CALLBACK_ALLOW_PRIVATE;
    });

    const job = (payload: Record<string, unknown>, requestId?: string) => ({
        scope: 'payout/test',
        chain: 'evm',
        requestId,
        payload
    });

    it('journals a payout without request_id under a generated one', async () => {
        const result = await runPayout(job({ amount: '1', private_key: 'secret' }), async () => '0xtx');

        const record = store.get(result.payoutId) as PayoutRecord;
        expect(record.status).to.equal('succeeded');
        expect(record.requestId).to.equal(result.requestId).and.to.have.length(36);
        expect(JSON.stringify(record)).to.not.contain('secret');
    });

    it('replays the journaled tx_id after a restart instead of paying again', async () => {
        const payload = { amount: '1' };
        const requestId = nextRequestId();
        const earlier = store.create({ scope: 'payout/test', requestId, fingerprint: payloadFingerprint(payload), chain: 'evm', request: payload });
        store.markSucceeded(earlier.id, '0xearlier');
        let calls = 0;

        const result = await runPayout(job(payload, requestId), async () => { calls += 1; return '0xnew'; });

        expect(result).to.deep.include({ txId: '0xearlier', replayed: true });
        expect(calls).to.equal(0);
    });

    it('refuses to guess when the earlier attempt was cut by a restart', async () => {
        const payload = { amount: '1' };
        const requestId = nextRequestId();
        const earlier = store.create({ scope: 'payout/test', requestId, fingerprint: payloadFingerprint(payload), chain: 'evm', request: payload });
        (store.get(earlier.id) as PayoutRecord).status = 'unknown';

        const error = await runPayout(job(payload, requestId), async () => '0xnew').catch((e) => e);

        expect(error).to.be.instanceOf(ApiError);
        expect(error).to.include({ status: 409, code: 'outcome_unknown' });
    });

    it('answers a different payload under a used request_id with a conflict', async () => {
        const requestId = nextRequestId();
        await runPayout(job({ amount: '1' }, requestId), async () => '0xtx');

        const error = await runPayout(job({ amount: '2' }, requestId), async () => '0xtx2').catch((e) => e);

        expect(error.name).to.equal('IdempotencyConflictError');
    });

    it('tries a failed payout again under the same record', async () => {
        const requestId = nextRequestId();
        const failure = await runPayout(job({ amount: '1' }, requestId), async () => {
            throw new ApiError(400, 'insufficient_funds', 'not enough');
        }).catch((e) => e);
        expect(failure.code).to.equal('insufficient_funds');
        expect(store.list({ requestId })[0]).to.deep.include({ status: 'failed', attempts: 1 });

        const result = await runPayout(job({ amount: '1' }, requestId), async () => '0xsecond');

        const record = store.get(result.payoutId) as PayoutRecord;
        expect(record).to.deep.include({ status: 'succeeded', txId: '0xsecond', attempts: 2 });
        expect(store.list({ requestId })).to.have.length(1);
    });

    it('runs concurrent identical requests once', async () => {
        const requestId = nextRequestId();
        let calls = 0;
        const handler = async () => {
            calls += 1;
            await new Promise((resolve) => { setTimeout(resolve, 30); });
            return '0xonce';
        };

        const [a, b] = await Promise.all([
            runPayout(job({ amount: '1' }, requestId), handler),
            runPayout(job({ amount: '1' }, requestId), handler)
        ]);

        expect(calls).to.equal(1);
        expect(a.txId).to.equal('0xonce');
        expect(b.txId).to.equal('0xonce');
    });

    it('settles a background payout from the receipt wait and posts the callback', async () => {
        process.env.CALLBACK_SECRET = 'shh';
        const result = await runPayout(
            { ...job({ amount: '1' }), callbackUrl, settlesInBackground: true },
            async () => {
                // what a service does when wait_for_receipt is false
                setTimeout(() => reportPayoutOutcome({ txId: '0xmined' }), 20);
                return '0xsent';
            }
        );
        expect(store.get(result.payoutId)?.status).to.equal('submitted');

        await waitFor(() => received.length === 1);

        expect(store.get(result.payoutId)).to.deep.include({ status: 'succeeded', txId: '0xmined' });
        expect(received[0].body).to.deep.include({ event: 'payout.succeeded' });
        expect(received[0].body.payout).to.deep.include({ status: 'succeeded', tx_id: '0xmined' });
        expect(received[0].headers['x-signature']).to.match(/^sha256=[0-9a-f]{64}$/);
        await waitFor(() => store.get(result.payoutId)?.callback?.status === 'delivered');
    });

    it('reports a failed payout to the callback with its error code', async () => {
        await runPayout({ ...job({ amount: '1' }), callbackUrl }, async () => {
            throw new ApiError(400, 'insufficient_funds', 'not enough');
        }).catch(() => undefined);

        await waitFor(() => received.length === 1);

        expect(received[0].body.payout).to.deep.include({ status: 'failed' });
        expect(received[0].body.payout.error).to.deep.equal({ code: 'insufficient_funds', message: 'not enough' });
    });

    it('does not call back into private networks unless allowed', async () => {
        delete process.env.CALLBACK_ALLOW_PRIVATE;
        const result = await runPayout({ ...job({ amount: '1' }), callbackUrl }, async () => '0xtx');

        await waitFor(() => store.get(result.payoutId)?.callback?.status === 'failed');

        expect(received).to.have.length(0);
        expect(store.get(result.payoutId)?.callback?.lastError).to.contain('private address');
    });
});

describe('isPrivateAddress', () => {
    it('blocks loopback, private and link-local ranges and lets public ones through', () => {
        for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
            expect(isPrivateAddress(ip), ip).to.equal(true);
        }
        for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
            expect(isPrivateAddress(ip), ip).to.equal(false);
        }
    });
});
