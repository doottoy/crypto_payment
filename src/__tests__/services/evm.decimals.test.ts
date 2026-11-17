/* External dependencies */
import 'mocha';
import { expect } from 'chai';
import { AddressInfo } from 'net';
import { createServer } from 'http';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { decodeFunctionData, numberToHex, parseTransaction, type Hex } from 'viem';

/* Service */
import { PayoutService } from '../../services/payout.service';

/* Constants */
import { Const } from '../../constants/const';

type Reply = { status?: number; result?: unknown; error?: { code: number; message: string } };
type Node = { url: string; ethCalls: () => number; close: () => Promise<void> };

const BASE_SEPOLIA_ID = 84532;
const BLOCK = '0x8adc40';
const PAYEE = privateKeyToAccount(generatePrivateKey()).address;
const TOKEN = privateKeyToAccount(generatePrivateKey()).address;

const SIX_DECIMALS: Reply = { result: numberToHex(6, { size: 32 }) };
const UNAVAILABLE: Reply = { status: 503 };
const INTERNAL_ERROR: Reply = { error: { code: -32603, message: 'internal error' } };
/* viem repeats a failed HTTP request and a -32603 answer, not this one, so each read is one request */
const SERVER_ERROR: Reply = { error: { code: -32000, message: 'header not found' } };
const NO_DATA: Reply = { result: '0x' };

/* A Base Sepolia node that answers eth_call (decimals() of the token) with the given reply */
function nodeReply(decimals: Reply): (method: string) => Reply {
    return (method) => {
        switch (method) {
            case 'eth_chainId': return { result: numberToHex(BASE_SEPOLIA_ID) };
            case 'eth_blockNumber': return { result: BLOCK };
            case 'eth_gasPrice': return { result: '0x5b8d80' };
            case 'eth_maxPriorityFeePerGas': return { result: '0x5f5e100' };
            case 'eth_estimateGas': return { result: '0xea60' };
            case 'eth_call': return decimals;
            case 'eth_getTransactionCount': return { result: '0x10' };
            case 'eth_getBlockByNumber': return {
                result: {
                    number: BLOCK,
                    hash: `0x${'11'.repeat(32)}`,
                    timestamp: '0x6720f000',
                    gasLimit: '0x1c9c380',
                    gasUsed: '0x0',
                    baseFeePerGas: '0x2540be400',
                    transactions: []
                }
            };
            default: return { error: { code: -32601, message: `method ${method} is not mocked` } };
        }
    };
}

/* Local JSON-RPC endpoint; a reply with a status other than 200 fails the HTTP request itself */
async function startNode(decimals: Reply): Promise<Node> {
    const reply = nodeReply(decimals);
    let ethCalls = 0;
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', () => {
            const { id, method } = JSON.parse(body);
            ethCalls += method === 'eth_call' ? 1 : 0;
            const { status = 200, ...answer } = reply(method);
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(status === 200 ? { jsonrpc: '2.0', id, ...answer } : { message: 'upstream unavailable' }));
        });
    });
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${port}`,
        ethCalls: () => ethCalls,
        close: () => new Promise<void>((resolve) => {
            server.close(() => resolve());
        })
    };
}

/* The raw amount the signed token transfer of a 0.015 payout carries, prepared through the given nodes in their order */
async function preparedAmount(nodes: Node[]): Promise<bigint> {
    const service = new PayoutService('base_erc20', generatePrivateKey());
    await service.init();
    (service as any).rpcUrls = nodes.map((node) => node.url);
    const prepared = await (service as any).prepareTxData(PAYEE, '0.015', TOKEN, 'DUSDT');
    await prepared.nonceLease.release(false);
    const { args } = decodeFunctionData({ abi: Const.ABI_CONTRACT as any, data: parseTransaction(prepared.rawTx as Hex).data as Hex });

    return args?.[1] as bigint;
}

describe('ERC-20 payout amount by the decimals of the token', () => {
    const nodes: Node[] = [];
    const start = async (...replies: Reply[]): Promise<Node[]> => {
        const started = await Promise.all(replies.map((reply) => startNode(reply)));
        nodes.push(...started);
        return started;
    };

    afterEach(async () => {
        await Promise.all(nodes.splice(0).map((node) => node.close()));
    });

    it('converts the amount with the decimals the token returns', async () => {
        expect(await preparedAmount(await start(SIX_DECIMALS))).to.equal(15000n);
    });

    it('reads the decimals from the next provider when one fails the HTTP request', async () => {
        expect(await preparedAmount(await start(UNAVAILABLE, SIX_DECIMALS))).to.equal(15000n);
    });

    it('reads the decimals from the next provider when one answers with a JSON-RPC error', async () => {
        expect(await preparedAmount(await start(INTERNAL_ERROR, SIX_DECIMALS))).to.equal(15000n);
    });

    it('fails the payout instead of guessing 18 decimals when every provider fails the read', async () => {
        let amount: bigint | undefined;
        let failure: any;
        try {
            amount = await preparedAmount(await start(UNAVAILABLE, INTERNAL_ERROR));
        } catch (error) {
            failure = error;
        }
        expect(amount, 'a signed transfer').to.equal(undefined);
        expect(String(failure?.message)).to.include('decimals');
    });

    it('reads the decimals at most once per provider and once more through the caller when every provider fails', async () => {
        const failing = await start(SERVER_ERROR, SERVER_ERROR, SERVER_ERROR);
        try {
            await preparedAmount(failing);
        } catch (error) {
            // the failure itself is covered above
        }
        const reads = failing.reduce((total, node) => total + node.ethCalls(), 0);
        expect(reads).to.be.at.most(failing.length + 1);
    });

    it('keeps 18 decimals for a token that has no decimals()', async () => {
        expect(await preparedAmount(await start(NO_DATA))).to.equal(15000000000000000n);
    });
});
