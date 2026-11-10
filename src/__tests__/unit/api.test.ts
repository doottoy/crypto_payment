import 'mocha';
import { expect } from 'chai';
import { AddressInfo } from 'net';
import { createServer, type Server } from 'http';

import { createApp } from '../../api/app';
import { modules } from '../../utils/modules';

type NodeReply = { status?: number; body: unknown };

const VALID_EVM_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const EVM_PAYEE = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

describe('HTTP API', () => {
    let server: Server;
    let baseUrl: string;

    // Mock Litecoin Core: records every JSON-RPC call and answers with `nodeReply`
    let node: Server;
    let nodeCalls: Array<{ method: string; params: unknown[] }>;
    let nodeReply: NodeReply;

    const { sendMessageToTelegram } = modules;
    let alerts: string[];

    before(async () => {
        server = createApp().listen(0);
        await new Promise((resolve) => server.once('listening', resolve));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

        node = createServer((req, res) => {
            let raw = '';
            req.on('data', (chunk) => { raw += chunk; });
            req.on('end', () => {
                const call = JSON.parse(raw);
                nodeCalls.push({ method: call.method, params: call.params });
                res.writeHead(nodeReply.status ?? 200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(nodeReply.body));
            });
        }).listen(0);
        await new Promise((resolve) => node.once('listening', resolve));
        process.env.RPC_URL = `http://127.0.0.1:${(node.address() as AddressInfo).port}`;
        process.env.RPC_USER = 'user';
        process.env.RPC_PASS = 'pass';
    });

    after(async () => {
        process.env.RPC_URL = '';
        process.env.RPC_USER = '';
        process.env.RPC_PASS = '';
        await new Promise((resolve) => server.close(resolve));
        await new Promise((resolve) => node.close(resolve));
    });

    beforeEach(() => {
        nodeCalls = [];
        nodeReply = { body: { result: 'ltc-txid', error: null, id: '1' } };
        alerts = [];
        modules.sendMessageToTelegram = async (message: string) => {
            alerts.push(message);
        };
    });

    afterEach(() => {
        modules.sendMessageToTelegram = sendMessageToTelegram;
    });

    async function post(path: string, body: unknown): Promise<{ status: number; body: any; text: string }> {
        const response = await fetch(`${baseUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: typeof body === 'string' ? body : JSON.stringify(body),
            // A hung request must fail the test instead of stalling the suite
            signal: AbortSignal.timeout(5000)
        });
        const text = await response.text();
        return { status: response.status, body: JSON.parse(text), text };
    }

    describe('error handling', () => {
        it('answers a body without data with a 400 instead of hanging', async () => {
            const res = await post('/payout/evm', {});

            expect(res.status).to.equal(400);
            expect(res.body.code).to.equal('invalid_request');
            expect(res.body.error).to.match(/^data:/);
        });

        it('names the invalid field', async () => {
            const res = await post('/payout/evm', {
                data: { payway: 'eth', payee_address: '0x123', amount: '0.1', private_key: VALID_EVM_KEY }
            });

            expect(res.status).to.equal(400);
            expect(res.body.details.map((d: any) => d.path)).to.deep.equal(['data.payee_address']);
        });

        it('rejects an unknown payway before touching any network', async () => {
            const res = await post('/payout/evm', {
                data: { payway: 'dogecoin', payee_address: EVM_PAYEE, amount: '0.1', private_key: VALID_EVM_KEY }
            });

            expect(res.status).to.equal(400);
            expect(res.body.details[0].path).to.equal('data.payway');
        });

        it('rejects a batch without transfers', async () => {
            const res = await post('/payout/evm/batch_send', {
                data: { payway: 'eth', private_key: VALID_EVM_KEY, batch_send_contract: EVM_PAYEE }
            });

            expect(res.status).to.equal(400);
            expect(res.body.error).to.contain('at least one');
        });

        it('answers malformed JSON with invalid_json', async () => {
            const res = await post('/payout/evm', '{"data": ');

            expect(res.status).to.equal(400);
            expect(res.body.code).to.equal('invalid_json');
        });

        it('never echoes a private key back', async () => {
            const secret = 'this-is-not-a-valid-key-but-still-secret';
            const res = await post('/payout/evm', {
                data: { payway: 'eth', payee_address: EVM_PAYEE, amount: '0.1', private_key: secret }
            });

            expect(res.status).to.equal(400);
            expect(res.text).to.not.contain(secret);
        });

        it('keeps the bridge destination error a 400 with a string error', async () => {
            const res = await post('/bridge/eth', {
                data: { destination: 'zksync', amount: '0.01', private_key: VALID_EVM_KEY }
            });

            expect(res.status).to.equal(400);
            expect(res.body.error).to.be.a('string').and.contain('destination');
        });

        it('validates the tron payload in both shapes', async () => {
            const current = await post('/payout/tron', { data: { payway: 'tron', private_key: VALID_EVM_KEY.slice(2) } });
            const legacy = await post('/payout/tron', { payway: 'tron', to: 'not-an-address', amount: '1', currency: 'TRX', private_key: VALID_EVM_KEY.slice(2) });

            expect(current.status).to.equal(400);
            expect(legacy.status).to.equal(400);
            expect(legacy.body.details.map((d: any) => d.path)).to.include('payee_address');
        });

        it('answers unknown routes with a JSON 404', async () => {
            const res = await post('/payout/unknown', {});

            expect(res.status).to.equal(404);
            expect(res.body.code).to.equal('not_found');
        });
    });

    describe('GET /health', () => {
        it('reports the service as up with its version', async () => {
            const response = await fetch(`${baseUrl}/health`);
            const body = await response.json();

            expect(response.status).to.equal(200);
            expect(body.status).to.equal('ok');
            expect(body.version).to.match(/^\d+\.\d+\.\d+$/);
        });
    });

    describe('Litecoin', () => {
        const payout = { payee_address: 'tltc1qexampleaddress', amount: '0.5', payway: 'ltc', currency: 'LTC' };

        it('refuses any node method other than sendtoaddress, without calling the node', async () => {
            const res = await post('/payout/ltc', { data: { ...payout, method: 'dumpprivkey' } });

            expect(res.status).to.equal(400);
            expect(res.body.details[0].path).to.equal('data.method');
            expect(nodeCalls).to.have.length(0);
        });

        it('always calls sendtoaddress and returns the txid', async () => {
            const res = await post('/payout/ltc', { data: { ...payout, method: 'sendtoaddress' } });

            expect(res.status).to.equal(200);
            expect(res.body).to.deep.equal({ tx_id: 'ltc-txid' });
            expect(nodeCalls).to.deep.equal([{ method: 'sendtoaddress', params: [payout.payee_address, '0.5'] }]);
        });

        it('fails on a node error instead of answering a null tx_id as a success', async () => {
            nodeReply = { status: 500, body: { result: null, error: { code: -6, message: 'Insufficient funds' }, id: '1' } };

            const res = await post('/payout/ltc', { data: payout });

            expect(res.status).to.equal(400);
            expect(res.body.code).to.equal('insufficient_funds');
            expect(alerts).to.have.length(1);
            expect(alerts[0]).to.contain('Insufficient funds');
        });

        it('maps an unreadable node answer to node_error', async () => {
            nodeReply = { status: 401, body: '' };

            const res = await post('/payout/ltc', { data: payout });

            expect(res.status).to.equal(502);
            expect(res.body.code).to.equal('node_error');
        });

        it('alerts once when sendmany fails', async () => {
            nodeReply = { status: 500, body: { result: null, error: { code: -5, message: 'Invalid address' }, id: '1' } };

            const res = await post('/payout/ltc/multi_send', {
                data: { recipients: [{ address: 'bad', amount: '0.1' }], payway: 'ltc', currency: 'LTC' }
            });

            expect(res.status).to.equal(400);
            expect(res.body.code).to.equal('invalid_address');
            expect(nodeCalls[0].method).to.equal('sendmany');
            expect(alerts).to.have.length(1);
        });

        it('rejects amounts finer than a litoshi', async () => {
            const res = await post('/payout/ltc', { data: { ...payout, amount: '0.123456789' } });

            expect(res.status).to.equal(400);
            expect(nodeCalls).to.have.length(0);
        });
    });
});
