/* External dependencies */
import 'mocha';
import * as http from 'http';
import { expect } from 'chai';
import { AddressInfo } from 'net';
import { baseSepolia } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http as httpTransport, keccak256, type Hex, type PublicClient } from 'viem';

/* Internal dependencies */
import { modules } from '../../utils/modules';
import { Const } from '../../constants/const';
import {
    isEvmNetworkError,
    isEvmProviderError,
    isEvmAlreadyKnownError,
    assertEvmReceiptSuccess,
    EvmTransactionRevertedError
} from '../../utils/evm';

/* Service */
import { PayoutService } from '../../services/payout.service';
import { MultiPayoutService } from '../../services/multi-payout.service';

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

/* Base Sepolia node that mines every broadcast tx at once; the receipt status is 0x1 (success) or 0x0 (reverted) */
function minedNode(status: '0x0' | '0x1'): RpcHandler {
    const node = baseSepoliaNode();
    return (method, params) => {
        switch (method) {
            case 'eth_sendRawTransaction': return { result: keccak256(params[0]) };
            case 'eth_blockNumber': return { result: '0x8adc40' };
            case 'eth_getTransactionReceipt': return {
                result: {
                    transactionHash: params[0],
                    transactionIndex: '0x0',
                    blockHash: `0x${'11'.repeat(32)}`,
                    blockNumber: '0x8adc40',
                    from: SENDER,
                    to: PAYEE,
                    cumulativeGasUsed: '0x5208',
                    gasUsed: '0x5208',
                    effectiveGasPrice: '0x5b8d80',
                    contractAddress: null,
                    logs: [],
                    logsBloom: `0x${'00'.repeat(256)}`,
                    status,
                    type: '0x0'
                }
            };
            default: return node(method, params);
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

async function waitFor(condition: () => boolean, timeoutMs: number = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
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

describe('assertEvmReceiptSuccess', () => {
    const HASH = `0x${'ab'.repeat(32)}` as Hex;
    const receipt = (status: 'success' | 'reverted') => ({ status, transactionHash: HASH, blockNumber: 9100352n, gasUsed: 30200n }) as any;

    it('passes a successful receipt and a receipt that was not waited for', () => {
        expect(() => assertEvmReceiptSuccess(receipt('success'))).to.not.throw();
        expect(() => assertEvmReceiptSuccess(undefined)).to.not.throw();
    });

    it('throws on a reverted receipt and reports the gas limit of the signed tx', async () => {
        const rawTx = await privateKeyToAccount(generatePrivateKey()).signTransaction({
            chainId: baseSepolia.id, to: PAYEE, value: 1n, gas: 30200n, gasPrice: 1n, nonce: 0
        });

        const error = await captureError(async () => assertEvmReceiptSuccess(receipt('reverted'), rawTx));

        expect(error).to.be.instanceOf(EvmTransactionRevertedError);
        expect(error.txHash).to.equal(HASH);
        expect(error.message).to.contain('gas used 30200 of 30200');
    });

    it('is final: no send loop fails it over to another provider or re-signs the spent nonce', async () => {
        const error = await captureError(async () => assertEvmReceiptSuccess(receipt('reverted')));
        const message = error.message.toLowerCase();

        expect(isEvmNetworkError(error)).to.equal(false);
        expect(isEvmProviderError(error)).to.equal(false);
        expect(isEvmAlreadyKnownError(error)).to.equal(false);
        expect([...Const.FEE_BUMP_ERROR_PATTERNS, ...Const.MINIMUM_TIP_ERROR_PATTERNS].some((p) => message.includes(p))).to.equal(false);
    });

    it('survives the JSON.stringify of the EVM error alert', async () => {
        const error = await captureError(async () => assertEvmReceiptSuccess(receipt('reverted')));

        expect(JSON.stringify(error)).to.contain(HASH).and.to.contain('reverted');
    });
});

describe('EVM payouts never report a reverted transaction as a success', () => {
    const nodes: MockRpc[] = [];
    const sendMessageToTelegram = modules.sendMessageToTelegram;
    let alerts: string[] = [];

    async function startNodes(...handlers: RpcHandler[]): Promise<string[]> {
        for (const handler of handlers) {
            nodes.push(await startRpc(handler));
        }
        return nodes.map((node) => node.url);
    }

    async function payoutVia(waitForReceipt: boolean, ...handlers: RpcHandler[]): Promise<string> {
        const urls = await startNodes(...handlers);
        // fresh sender per case: the nonce allocator is process-wide and keyed by chain + address
        const service = new PayoutService('base_eth', generatePrivateKey());
        await service.init();
        (service as any).rpcUrls = urls;

        return service.sendTransaction(PAYEE, '0.000001', '', 'ETH', waitForReceipt);
    }

    beforeEach(() => {
        alerts = [];
        modules.sendMessageToTelegram = async (message: string) => {
            alerts.push(message);
        };
    });

    afterEach(async () => {
        modules.sendMessageToTelegram = sendMessageToTelegram;
        await Promise.all(nodes.splice(0).map((node) => node.close()));
    });

    it('fails a payout whose tx reverted and does not retry it on the next provider', async () => {
        const error = await captureError(() => payoutVia(true, minedNode('0x0'), minedNode('0x1')));

        expect(error).to.be.instanceOf(EvmTransactionRevertedError);
        expect(error.gasLimit).to.equal('30200');
        expect(nodes[1].calls).to.deep.equal([]);
        expect(alerts).to.have.length(1);
        expect(alerts[0]).to.contain('Type: Error').and.to.contain(error.txHash);
    });

    it('still confirms a payout whose tx succeeded', async () => {
        const hash = await payoutVia(true, minedNode('0x1'));

        expect(hash).to.match(/^0x[0-9a-f]{64}$/);
        expect(alerts).to.have.length(1);
        expect(alerts[0]).to.contain('Type: EVM transaction');
    });

    it('alerts an error, not a success, when a payout sent without waiting reverts later', async () => {
        const hash = await payoutVia(false, minedNode('0x0'));

        await waitFor(() => alerts.length > 0);
        expect(alerts).to.have.length(1);
        expect(alerts[0]).to.contain('Type: Error').and.to.contain(hash);
    });

    it('fails a fan-out send (multi-send, batch send, bridge) whose tx reverted', async () => {
        const urls = await startNodes(minedNode('0x0'));
        const service = new MultiPayoutService('base_eth', generatePrivateKey());
        await service.init(PAYEE);
        (service as any).rpcUrls = urls;
        const rawTx = await (service as any).account.signTransaction({
            chainId: baseSepolia.id, to: PAYEE, value: 1n, gas: 50000n, gasPrice: 1n, nonce: 0
        });

        const error = await captureError(() => (service as any).fanoutSend(rawTx, true));

        expect(error).to.be.instanceOf(EvmTransactionRevertedError);
        expect(error.gasLimit).to.equal('50000');
    });
});
