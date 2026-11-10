import 'mocha';
import { expect } from 'chai';
import { AddressInfo } from 'net';
import { createServer, type Server } from 'http';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, numberToHex, parseTransaction, type Hex } from 'viem';

import { createApp } from '../../api/app';
import { modules } from '../../utils/modules';
import { Const } from '../../constants/const';
import { getPayoutStore } from '../../payouts/store';

/*
 * End to end through the HTTP routes: request -> validation -> journal -> service -> JSON-RPC -> response.
 * The provider lists in Const point at a local mock chain that mines every broadcast at once, so these tests prove
 * the routes still drive the real EVM services the way they did before the API layer changed.
 */

const BASE_SEPOLIA_ID = 84532;
const SEPOLIA_ID = 11155111;
const BLOCK = '0x8adc40';
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const PAYEE = privateKeyToAccount(generatePrivateKey()).address;
const CONTRACT = privateKeyToAccount(generatePrivateKey()).address;

interface MockChain {
    url: string;
    broadcasts: Hex[];
    close: () => Promise<void>;
}

async function startMockChain(sender: string, chainId: number): Promise<MockChain> {
    const from = sender.toLowerCase();
    const txs = new Map<string, any>();
    const broadcasts: Hex[] = [];

    const handle = (method: string, params: any[]): { result?: unknown; error?: unknown } => {
        switch (method) {
            case 'eth_chainId': return { result: numberToHex(chainId) };
            case 'eth_blockNumber': return { result: BLOCK };
            case 'eth_gasPrice': return { result: '0x5b8d80' };
            case 'eth_maxPriorityFeePerGas': return { result: '0x5f5e100' };
            case 'eth_estimateGas': return { result: '0x5208' };
            // decimals() of a token or multi-send contract, allowance() of a token
            case 'eth_call': return { result: numberToHex(18, { size: 32 }) };
            case 'eth_getTransactionCount': return { result: numberToHex(5 + broadcasts.length) };
            case 'eth_getBlockByNumber':
                return { result: { number: BLOCK, hash: BLOCK_HASH, timestamp: '0x6720f000', gasLimit: '0x1c9c380', gasUsed: '0x0', baseFeePerGas: '0x3b9aca00', transactions: [] } };
            case 'eth_getTransactionByHash': return { result: txs.get(params[0]) ?? null };
            case 'eth_getTransactionReceipt': {
                const tx = txs.get(params[0]);
                if (!tx) return { result: null };
                return {
                    result: {
                        transactionHash: tx.hash, transactionIndex: '0x0', blockHash: BLOCK_HASH, blockNumber: BLOCK, from, to: tx.to,
                        cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x5b8d80', contractAddress: null,
                        logs: [], logsBloom: `0x${'00'.repeat(256)}`, status: '0x1', type: tx.type
                    }
                };
            }
            case 'eth_sendRawTransaction': {
                const raw = params[0] as Hex;
                const parsed = parseTransaction(raw);
                const hash = keccak256(raw);
                broadcasts.push(raw);
                txs.set(hash, {
                    hash, from, to: parsed.to?.toLowerCase() ?? null, nonce: numberToHex(parsed.nonce ?? 0), value: numberToHex(parsed.value ?? 0n),
                    input: parsed.data ?? '0x', gas: numberToHex(parsed.gas ?? 0n), chainId: numberToHex(chainId),
                    type: parsed.type === 'eip1559' ? '0x2' : '0x0', gasPrice: '0x5b8d80',
                    blockHash: BLOCK_HASH, blockNumber: BLOCK, transactionIndex: '0x0', v: '0x0', r: '0x1', s: '0x1'
                });
                return { result: hash };
            }
            default: return { error: { code: -32601, message: `method ${method} is not mocked` } };
        }
    };

    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            const parsed = JSON.parse(body);
            const replies = [parsed].flat().map(({ id, method, params }) => ({ jsonrpc: '2.0', id, ...handle(method, params || []) }));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
        });
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });

    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        broadcasts,
        close: () => new Promise<void>((resolve) => { server.close(() => resolve()); })
    };
}

describe('EVM routes end to end', () => {
    let app: Server;
    let baseUrl: string;
    let chain: MockChain;
    let l1: MockChain;
    const key = generatePrivateKey();
    const sender = privateKeyToAccount(key).address;
    const providers = { ...Const.EVM_RPC_PROVIDERS };
    const { sendMessageToTelegram } = modules;

    before(async () => {
        modules.sendMessageToTelegram = async () => undefined;
        chain = await startMockChain(sender, BASE_SEPOLIA_ID);
        l1 = await startMockChain(sender, SEPOLIA_ID);
        Const.EVM_RPC_PROVIDERS.base_eth = [chain.url];
        Const.EVM_RPC_PROVIDERS.eth = [l1.url];

        app = createApp().listen(0);
        await new Promise((resolve) => app.once('listening', resolve));
        baseUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    });

    after(async () => {
        Object.assign(Const.EVM_RPC_PROVIDERS, providers);
        modules.sendMessageToTelegram = sendMessageToTelegram;
        await new Promise((resolve) => app.close(resolve));
        await chain.close();
        await l1.close();
    });

    async function post(path: string, data: Record<string, unknown>) {
        const response = await fetch(`${baseUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data }),
            signal: AbortSignal.timeout(20000)
        });
        return { status: response.status, body: await response.json(), headers: response.headers };
    }

    it('pays native ETH and answers the mined hash, exactly as before', async () => {
        const res = await post('/payout/evm', { payway: 'base_eth', payee_address: PAYEE, amount: '0.000001', currency: 'ETH', private_key: key });

        expect(res.status).to.equal(200);
        expect(res.body).to.deep.equal({ tx_id: keccak256(chain.broadcasts[chain.broadcasts.length - 1]) });
        expect(getPayoutStore().get(res.headers.get('x-payout-id') as string)?.status).to.equal('succeeded');
    });

    it('pays an ERC20 token when a contract is given', async () => {
        const res = await post('/payout/evm', { payway: 'base_eth', payee_address: PAYEE, amount: '1.5', contract: CONTRACT, currency: 'USDT', private_key: key });

        expect(res.status).to.equal(200);
        const sent = parseTransaction(chain.broadcasts[chain.broadcasts.length - 1]);
        expect(sent.to?.toLowerCase()).to.equal(CONTRACT.toLowerCase());
        expect(sent.data?.startsWith('0xa9059cbb')).to.equal(true); // transfer(address,uint256)
    });

    it('answers at once with wait_for_receipt false and settles the journal in the background', async () => {
        const res = await post('/payout/evm', { payway: 'base_eth', payee_address: PAYEE, amount: '0.000001', private_key: key, wait_for_receipt: false });
        const payoutId = res.headers.get('x-payout-id') as string;

        expect(res.status).to.equal(200);
        expect(res.body.tx_id).to.match(/^0x[0-9a-f]{64}$/);
        await new Promise<void>((resolve, reject) => {
            const started = Date.now();
            const tick = () => {
                if (getPayoutStore().get(payoutId)?.status === 'succeeded') return resolve();
                if (Date.now() - started > 15000) return reject(new Error('background receipt wait did not settle'));
                setTimeout(tick, 50);
            };
            tick();
        });
    });

    it('keeps the old meaning of wait_for_receipt: null (no wait)', async () => {
        const res = await post('/payout/evm', { payway: 'base_eth', payee_address: PAYEE, amount: '0.000001', private_key: key, wait_for_receipt: null });

        expect(res.status).to.equal(200);
        expect(getPayoutStore().get(res.headers.get('x-payout-id') as string)?.status).to.be.oneOf(['submitted', 'succeeded']);
    });

    it('multi-sends through the contract', async () => {
        const res = await post('/payout/evm/multi_send', {
            payway: 'base_eth', recipients: [{ address: PAYEE, amount: '0.000001' }], currency: 'ETH', private_key: key, multi_send_contract: CONTRACT
        });

        expect(res.status).to.equal(200);
        expect(parseTransaction(chain.broadcasts[chain.broadcasts.length - 1]).to?.toLowerCase()).to.equal(CONTRACT.toLowerCase());
    });

    it('batch-sends native transfers', async () => {
        const res = await post('/payout/evm/batch_send', {
            payway: 'base_eth', private_key: key, currency: 'ETH', batch_send_contract: CONTRACT, native_transfers: [{ to: PAYEE, amount: '0.000001' }]
        });

        expect(res.status).to.equal(200);
        expect(res.body.tx_id).to.match(/^0x[0-9a-f]{64}$/);
    });

    it('bridges from Sepolia to Base', async () => {
        const res = await post('/bridge/eth', { destination: 'base', amount: '0.000001', private_key: key });

        expect(res.status).to.equal(200);
        expect(parseTransaction(l1.broadcasts[l1.broadcasts.length - 1]).to?.toLowerCase()).to.equal(Const.BASE_SEPOLIA_L1_STANDARD_BRIDGE.toLowerCase());
    });

    it('replays a retried request_id without broadcasting again', async () => {
        const data = { payway: 'base_eth', payee_address: PAYEE, amount: '0.000002', private_key: key, request_id: `e2e-${Date.now()}` };

        const first = await post('/payout/evm', data);
        const before = chain.broadcasts.length;
        const retry = await post('/payout/evm', data);

        expect(retry.body).to.deep.equal(first.body);
        expect(chain.broadcasts.length).to.equal(before);
    });
});
