/* External dependencies */
import 'mocha';
import * as http from 'http';
import { expect } from 'chai';
import { AddressInfo } from 'net';
import { baseSepolia } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http as httpTransport, type PublicClient } from 'viem';

/* Internal dependencies */
import { isEvmNetworkError, isEvmProviderError } from '../../utils/evm';

/* Service */
import { PayoutService } from '../../services/payout.service';

type RpcReply = { result?: unknown; error?: { code: number; message: string; data?: string }; status?: number };
type RpcHandler = (method: string, params: any[]) => RpcReply;
type MockRpc = { url: string; calls: string[]; close: () => Promise<void> };

/* Verbatim reply of base-sepolia.drpc.org (HTTP 200) to every pending-tag call and to eth_sendRawTransaction */
const DRPC_FLASHBLOCKS_REFUSAL = {
    code: 1,
    message: 'no available upstreams to process a request. Cause - upstream-80 - No label `flashblocks` with values [true]'
};

const SENDER = privateKeyToAccount(generatePrivateKey()).address;
const PAYEE = privateKeyToAccount(generatePrivateKey()).address;

/* Local JSON-RPC endpoint, so viem builds its errors exactly as it does against a real provider */
async function startRpc(handler: RpcHandler): Promise<MockRpc> {
    const calls: string[] = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', () => {
            const { id, method, params } = JSON.parse(body);
            calls.push(method);
            const { status = 200, ...reply } = handler(method, params || []);
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id, ...reply }));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise<void>((resolve) => server.close(() => resolve()))
    };
}

/* Healthy Base Sepolia node; `overrides` replaces the reply of a single method */
function baseSepoliaNode(overrides: Record<string, RpcReply> = {}): RpcHandler {
    return (method) => {
        if (overrides[method]) return overrides[method];
        switch (method) {
            case 'eth_chainId': return { result: '0x14a34' };
            case 'eth_gasPrice': return { result: '0x5b8d80' };
            case 'eth_estimateGas': return { result: '0x5208' };
            case 'eth_getTransactionCount': return { result: '0x10' };
            default: return { error: { code: -32601, message: `method ${method} is not mocked` } };
        }
    };
}

async function captureError(action: () => Promise<unknown>): Promise<any> {
    try {
        await action();
    } catch (error) {
        return error;
    }
    throw new Error('Expected the call to fail');
}

describe('isEvmProviderError', () => {
    let rpc: MockRpc;
    let client: PublicClient;

    async function useNode(handler: RpcHandler) {
        rpc = await startRpc(handler);
        client = createPublicClient({ chain: baseSepolia, transport: httpTransport(rpc.url) }) as PublicClient;
    }

    afterEach(async () => {
        await rpc?.close();
    });

    it('treats the drpc flashblocks refusal as a provider error', async () => {
        await useNode(baseSepoliaNode({ eth_getTransactionCount: { error: DRPC_FLASHBLOCKS_REFUSAL } }));

        const error = await captureError(() => client.getTransactionCount({ address: SENDER, blockTag: 'pending' }));

        expect(isEvmProviderError(error)).to.equal(true);
        expect(isEvmNetworkError(error)).to.equal(true);
    });

    it('treats a JSON-RPC refusal with unknown wording as a provider error', async () => {
        await useNode(baseSepoliaNode({ eth_getTransactionCount: { error: { code: 1, message: 'upstream refused the call' } } }));

        const error = await captureError(() => client.getTransactionCount({ address: SENDER, blockTag: 'pending' }));

        expect(isEvmNetworkError(error)).to.equal(false);
        expect(isEvmProviderError(error)).to.equal(true);
    });

    it('treats an HTTP error status as a provider error', async () => {
        await useNode(baseSepoliaNode({
            eth_getTransactionCount: { status: 400, error: { code: 35, message: 'chain is not available on free plan, please upgrade to paid plan' } }
        }));

        const error = await captureError(() => client.getTransactionCount({ address: SENDER, blockTag: 'pending' }));

        expect(isEvmProviderError(error)).to.equal(true);
    });

    it('does not treat a reverted transaction as a provider error', async () => {
        await useNode(baseSepoliaNode({
            eth_estimateGas: { error: { code: 3, message: 'execution reverted: ERC20: transfer amount exceeds balance' } }
        }));

        const error = await captureError(() => client.estimateGas({ account: SENDER, to: PAYEE, value: 1n }));

        expect(isEvmProviderError(error)).to.equal(false);
    });

    it('does not treat insufficient funds as a provider error', async () => {
        await useNode(baseSepoliaNode({
            eth_estimateGas: { error: { code: -32000, message: 'insufficient funds for gas * price + value: balance 0, tx cost 21000' } }
        }));

        const error = await captureError(() => client.estimateGas({ account: SENDER, to: PAYEE, value: 1n }));

        expect(isEvmProviderError(error)).to.equal(false);
    });

    it('does not treat a local error as a provider error', () => {
        expect(isEvmProviderError(new Error('Unsupported payway for chain mapping: base'))).to.equal(false);
    });
});

describe('PayoutService tx preparation fail-over', () => {
    const nodes: MockRpc[] = [];

    async function prepareVia(...handlers: RpcHandler[]) {
        for (const handler of handlers) {
            nodes.push(await startRpc(handler));
        }
        // fresh sender per case: the nonce allocator is process-wide and keyed by chain + address
        const service = new PayoutService('base_eth', generatePrivateKey());
        await service.init();
        (service as any).rpcUrls = nodes.map((node) => node.url);

        return (service as any).prepareTxData(PAYEE, '0.000001', '', 'ETH');
    }

    afterEach(async () => {
        await Promise.all(nodes.splice(0).map((node) => node.close()));
    });

    it('moves to the next provider when the first one refuses the pending nonce lookup', async () => {
        const prepared = await prepareVia(
            baseSepoliaNode({ eth_getTransactionCount: { error: DRPC_FLASHBLOCKS_REFUSAL } }),
            baseSepoliaNode()
        );

        expect(prepared.nonceLease.nonce).to.equal(16);
        expect(nodes[1].calls).to.include('eth_getTransactionCount');
        await prepared.nonceLease.release(false);
    });

    it('moves to the next provider on a refusal no error pattern knows', async () => {
        const prepared = await prepareVia(
            baseSepoliaNode({ eth_getTransactionCount: { error: { code: 1, message: 'upstream refused the call' } } }),
            baseSepoliaNode()
        );

        expect(prepared.nonceLease.nonce).to.equal(16);
        await prepared.nonceLease.release(false);
    });

    it('fails fast when the node rejects the transaction itself', async () => {
        const error = await captureError(() => prepareVia(
            baseSepoliaNode({ eth_estimateGas: { error: { code: 3, message: 'execution reverted' } } }),
            baseSepoliaNode()
        ));

        expect(isEvmProviderError(error)).to.equal(false);
        expect(nodes[1].calls).to.deep.equal([]);
    });
});
