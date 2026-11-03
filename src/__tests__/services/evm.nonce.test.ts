/* External dependencies */
import 'mocha';
import { expect } from 'chai';
import { AddressInfo } from 'net';
import { createServer } from 'http';
import { baseSepolia } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, keccak256, numberToHex, parseTransaction, toHex, type Address, type Hex, type PublicClient } from 'viem';

/* Internal dependencies */
import { modules } from '../../utils/modules';
import { nonceAllocator } from '../../utils/nonce-allocator';
import {
    assertOwnReceipt,
    isEvmNetworkError,
    isEvmProviderError,
    EvmNonceTakenError,
    isEvmAlreadyKnownError
} from '../../utils/evm';

/* Service */
import { PayoutService } from '../../services/payout.service';
import { EthBridgeService } from '../../services/eth-bridge.service';
import { MultiPayoutService } from '../../services/multi-payout.service';
import { EvmBatchPayoutService } from '../../services/evm.batch-payout.service';

/* Constants */
import { Const } from '../../constants/const';

type RpcReply = { result?: unknown; error?: { code: number; message: string } };
type RpcHandler = (method: string, params: any[]) => RpcReply;
type RpcFilter = (method: string, params: any[]) => boolean;

/* What the mock chain does with a broadcast tx: mines it, keeps it pending, mines a foreign tx on its nonce, or refuses it */
type Fate = 'mine' | 'pending' | 'foreign' | { refuse: string; mined: boolean };

type MockChain = {
    url: string;
    handler: RpcHandler;
    sent: { hash: Hex; nonce: number }[];
    foreign: Hex[];
    // mines txs of the sender on its next nonces, as a send from outside this process would
    sendElsewhere: (count: number) => void;
    close: () => Promise<void>;
};

const BASE_SEPOLIA_ID = 84532;
const SEPOLIA_ID = 11155111;
const START_NONCE = 16;
const BLOCK = '0x8adc40';
const BLOCK_HASH = `0x${'11'.repeat(32)}`;
const PAYEE = privateKeyToAccount(generatePrivateKey()).address;
const CONTRACT = privateKeyToAccount(generatePrivateKey()).address;
const STRANGER = privateKeyToAccount(generatePrivateKey()).address;

const byNumber = (left: number, right: number) => left - right;

function senderOf(key: Hex): Address {
    return privateKeyToAccount(key).address;
}

/* Allocator bookkeeping of one sender */
function allocatorState(address: Address, chainId: number): { inFlight: Set<number>; needsResync: boolean } | undefined {
    return (nonceAllocator as any).states.get(`${chainId}:${address.toLowerCase()}`);
}

function leasesInFlight(key: Hex, chainId: number = BASE_SEPOLIA_ID): number {
    return allocatorState(senderOf(key), chainId)?.inFlight.size ?? 0;
}

async function captureError(action: () => Promise<unknown>): Promise<any> {
    try {
        await action();
    } catch (error) {
        return error;
    }
    throw new Error('Expected the call to fail');
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
        await new Promise((resolve) => {
            setTimeout(resolve, 20);
        });
    }
}

/* Local JSON-RPC endpoint, so viem runs its real receipt polling and replacement detection against it */
async function startRpc(handler: RpcHandler): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', () => {
            const { id, method, params } = JSON.parse(body);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id, ...handler(method, params || []) }));
        });
    });
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((resolve) => {
            server.close(() => resolve());
        })
    };
}

/* Refuses every pending nonce read */
const refusePendingNonce: RpcFilter = (method, params) => method === 'eth_getTransactionCount' && params[1] === 'pending';

/* Refuses the pending block from its n-th request on */
function refusePendingBlock(n: number): RpcFilter {
    let calls = 0;
    return (method, params) => {
        if (method !== 'eth_getBlockByNumber' || params[0] !== 'pending') return false;
        calls += 1;
        return calls >= n;
    };
}

/**
 * One sender on a mock chain whose pending nonce starts at START_NONCE. The 'foreign' fate mines a tx the sender did not
 * sign on the nonce of the broadcast one and leaves ours pending, so waiting for ours resolves with the foreign receipt.
 */
async function startChain(sender: Address, chainId: number, fateOf: (index: number) => Fate): Promise<MockChain> {
    const from = sender.toLowerCase();
    const txs = new Map<string, any>();
    const minedByNonce = new Map<number, any>();
    const sent: { hash: Hex; nonce: number }[] = [];
    const foreign: Hex[] = [];

    const toRpcTx = (rawTx: Hex) => {
        const tx = parseTransaction(rawTx);
        const fees = tx.type === 'eip1559'
            ? {
                type: '0x2',
                maxFeePerGas: numberToHex(tx.maxFeePerGas ?? 0n),
                maxPriorityFeePerGas: numberToHex(tx.maxPriorityFeePerGas ?? 0n)
            }
            : { type: '0x0', gasPrice: numberToHex(tx.gasPrice ?? 0n) };
        return {
            ...fees,
            hash: keccak256(rawTx),
            from,
            to: tx.to?.toLowerCase() ?? null,
            nonce: numberToHex(tx.nonce ?? 0),
            value: numberToHex(tx.value ?? 0n),
            input: tx.data ?? '0x',
            gas: numberToHex(tx.gas ?? 0n),
            chainId: numberToHex(chainId),
            blockHash: null,
            blockNumber: null,
            transactionIndex: null,
            v: '0x0',
            r: '0x1',
            s: '0x1'
        };
    };

    const mine = (tx: any) => {
        Object.assign(tx, { blockHash: BLOCK_HASH, blockNumber: BLOCK, transactionIndex: '0x0' });
        txs.set(tx.hash, tx);
        minedByNonce.set(Number(tx.nonce), tx);
    };

    const receiptOf = (tx: any) => ({
        transactionHash: tx.hash,
        transactionIndex: '0x0',
        blockHash: BLOCK_HASH,
        blockNumber: BLOCK,
        from,
        to: tx.to,
        cumulativeGasUsed: '0x5208',
        gasUsed: '0x5208',
        effectiveGasPrice: '0x5b8d80',
        contractAddress: null,
        logs: [],
        logsBloom: `0x${'00'.repeat(256)}`,
        status: '0x1',
        type: tx.type
    });

    const broadcast = (rawTx: Hex): RpcReply => {
        const tx = toRpcTx(rawTx);
        const fate = fateOf(sent.length);
        sent.push({ hash: tx.hash, nonce: Number(tx.nonce) });

        if (typeof fate === 'object') {
            if (fate.mined) mine(tx);
            return { error: { code: -32000, message: fate.refuse } };
        }
        if (fate === 'mine') {
            mine(tx);
        } else {
            txs.set(tx.hash, tx);
        }
        if (fate === 'foreign') {
            const other = { ...tx, hash: keccak256(toHex(`foreign:${tx.hash}`)), to: STRANGER.toLowerCase(), value: '0x1', input: '0x' };
            foreign.push(other.hash);
            mine(other);
        }
        return { result: tx.hash };
    };

    const handler: RpcHandler = (method, params) => {
        switch (method) {
            case 'eth_chainId': return { result: numberToHex(chainId) };
            case 'eth_blockNumber': return { result: BLOCK };
            case 'eth_gasPrice': return { result: '0x5b8d80' };
            case 'eth_maxPriorityFeePerGas': return { result: '0x5f5e100' };
            case 'eth_estimateGas': return { result: '0x5208' };
            // decimals() of the multi-send contract
            case 'eth_call': return { result: numberToHex(18, { size: 32 }) };
            case 'eth_getTransactionCount': return { result: numberToHex(START_NONCE + minedByNonce.size) };
            case 'eth_getBlockByNumber': {
                const mined = [...minedByNonce.values()];
                return {
                    result: {
                        number: BLOCK,
                        hash: BLOCK_HASH,
                        timestamp: '0x6720f000',
                        gasLimit: '0x1c9c380',
                        gasUsed: '0x0',
                        // 10 gwei, so a fee bump (+5 gwei tip) stays under the bumped fee cap
                        baseFeePerGas: '0x2540be400',
                        transactions: params[1] ? mined : mined.map((tx) => tx.hash)
                    }
                };
            }
            case 'eth_getTransactionByHash': return { result: txs.get(params[0]) ?? null };
            case 'eth_getTransactionReceipt': {
                const tx = txs.get(params[0]);
                return { result: tx?.blockNumber ? receiptOf(tx) : null };
            }
            case 'eth_sendRawTransaction': return broadcast(params[0]);
            default: return { error: { code: -32601, message: `method ${method} is not mocked` } };
        }
    };

    const sendElsewhere = (count: number) => {
        for (let i = 0; i < count; i += 1) {
            const nonce = numberToHex(START_NONCE + minedByNonce.size);
            mine({ hash: keccak256(toHex(`elsewhere:${nonce}`)), from, nonce, to: STRANGER.toLowerCase(), value: '0x1', input: '0x', type: '0x0' });
        }
    };

    const rpc = await startRpc(handler);
    return { ...rpc, handler, sent, foreign, sendElsewhere };
}

async function payoutVia(urls: string | string[], key: Hex, waitForReceipt = true): Promise<string> {
    const service = new PayoutService('base_eth', key);
    await service.init();
    (service as any).rpcUrls = [urls].flat();
    return service.sendTransaction(PAYEE, '0.000001', '', 'ETH', waitForReceipt);
}

async function multiSendService(urls: string | string[], key: Hex): Promise<MultiPayoutService> {
    const service = new MultiPayoutService('base_eth', key);
    await service.init(CONTRACT);
    (service as any).rpcUrls = [urls].flat();
    return service;
}

async function multiSendVia(urls: string | string[], key: Hex, waitForReceipt = true): Promise<string> {
    const service = await multiSendService(urls, key);
    return service.multiSend([{ address: PAYEE, amount: '0.000001' }], CONTRACT, 'ETH', waitForReceipt);
}

async function batchSendVia(urls: string | string[], key: Hex): Promise<string> {
    const service = new EvmBatchPayoutService('base_eth', key);
    await service.init(CONTRACT);
    (service as any).rpcUrls = [urls].flat();
    return service.batchSend([{ to: PAYEE, amount: '0.000001' }], [], 'ETH', true);
}

async function bridgeVia(urls: string | string[], key: Hex): Promise<string> {
    const service = new EthBridgeService(key);
    await service.init();
    (service as any).rpcUrls = [urls].flat();
    return service.deposit('base', '0.000001', undefined, true);
}

describe('EVM sends from one key', () => {
    const servers: { close: () => Promise<void> }[] = [];
    const { sendMessageToTelegram } = modules;
    let alerts: string[] = [];

    // fresh key per case: the nonce allocator is process-wide and keyed by chain + address
    async function chainFor(key: Hex, fateOf: (index: number) => Fate, chainId: number = BASE_SEPOLIA_ID): Promise<MockChain> {
        const chain = await startChain(senderOf(key), chainId, fateOf);
        servers.push(chain);
        return chain;
    }

    /* Another provider of the same chain that refuses the calls `refuses` matches */
    async function providerFor(chain: MockChain, refuses: RpcFilter): Promise<string> {
        // code 1: a refusal viem does not retry
        const provider = await startRpc((method, params) => (refuses(method, params)
            ? { error: { code: 1, message: `${method} refused` } }
            : chain.handler(method, params)));
        servers.push(provider);
        return provider.url;
    }

    beforeEach(() => {
        alerts = [];
        modules.sendMessageToTelegram = async (message: string) => {
            alerts.push(message);
        };
    });

    afterEach(async () => {
        modules.sendMessageToTelegram = sendMessageToTelegram;
        await Promise.all(servers.splice(0).map((server) => server.close()));
    });

    describe('take their nonces from one allocator', () => {
        it('gives concurrent multi_send preparations different nonces', async () => {
            const key = generatePrivateKey();
            const chain = await chainFor(key, () => 'mine');
            const services = await Promise.all([multiSendService(chain.url, key), multiSendService(chain.url, key)]);

            const prepared = await Promise.all(
                services.map((service) => (service as any).prepareCommon([{ address: PAYEE, amount: '0.000001' }], CONTRACT))
            );

            expect(prepared.map((prep) => prep.nonceLease.nonce).sort(byNumber)).to.deep.equal([16, 17]);
            await Promise.all(prepared.map((prep) => prep.nonceLease.release(true)));
            expect(leasesInFlight(key)).to.equal(0);
        });

        it('gives concurrent batch_send calls different nonces', async () => {
            const key = generatePrivateKey();
            const chain = await chainFor(key, () => 'mine');

            const hashes = await Promise.all([batchSendVia(chain.url, key), batchSendVia(chain.url, key)]);

            expect(chain.sent.map((tx) => tx.nonce).sort(byNumber)).to.deep.equal([16, 17]);
            expect(hashes).to.have.members(chain.sent.map((tx) => tx.hash));
            expect(leasesInFlight(key)).to.equal(0);
        });

        it('gives a payout, a multi_send and a batch_send sent at once different nonces', async () => {
            const key = generatePrivateKey();
            const chain = await chainFor(key, () => 'mine');

            const hashes = await Promise.all([payoutVia(chain.url, key), multiSendVia(chain.url, key), batchSendVia(chain.url, key)]);

            expect(chain.sent.map((tx) => tx.nonce).sort(byNumber)).to.deep.equal([16, 17, 18]);
            expect(hashes).to.have.members(chain.sent.map((tx) => tx.hash));
            expect(leasesInFlight(key)).to.equal(0);
        });

        it('multi_send moves on to the next provider when one refuses the pending block', async () => {
            const key = generatePrivateKey();
            const chain = await chainFor(key, () => 'mine');
            // a first send fills the allocator, so the next preparation reads no pending nonce of its own
            await multiSendVia(chain.url, key);
            const refusing = await providerFor(chain, refusePendingBlock(1));

            const hash = await multiSendVia([refusing, chain.url], key);

            expect(chain.sent.map((tx) => tx.nonce)).to.deep.equal([16, 17]);
            expect(hash).to.equal(chain.sent[1].hash);
            expect(leasesInFlight(key)).to.equal(0);
        });

        it('multi_send gives its nonce back when its tx is refused', async () => {
            const key = generatePrivateKey();
            const chain = await chainFor(key, () => ({ refuse: 'execution reverted', mined: false }));

            const error = await captureError(() => multiSendVia(chain.url, key));

            expect(error.message).to.contain('execution reverted');
            expect(chain.sent.map((tx) => tx.nonce)).to.deep.equal([16]);
            expect(leasesInFlight(key)).to.equal(0);
            expect(allocatorState(senderOf(key), BASE_SEPOLIA_ID)?.needsResync).to.equal(true);
        });

        it('batch_send gives its nonce back when it fails before broadcasting', async () => {
            const key = generatePrivateKey();
            const chain = await chainFor(key, () => 'mine');
            // a batch_send probes the provider twice (pending block) before the fee lookup after the nonce is reserved
            const provider = await providerFor(chain, refusePendingBlock(3));

            const error = await captureError(() => batchSendVia(provider, key));

            expect(error.message).to.contain('refused');
            expect(chain.sent).to.deep.equal([]);
            expect(leasesInFlight(key)).to.equal(0);
            expect(allocatorState(senderOf(key), BASE_SEPOLIA_ID)?.needsResync).to.equal(true);
        });

        it('payout skips a provider refusing the pending nonce and the nonces the key used elsewhere', async () => {
            const key = generatePrivateKey();
            const chain = await chainFor(key, () => 'mine');
            // the allocator now caches 17, then the key sends 17 and 18 outside this process
            await payoutVia(chain.url, key);
            chain.sendElsewhere(2);
            const refusing = await providerFor(chain, refusePendingNonce);

            const hash = await payoutVia([refusing, chain.url], key);

            expect(chain.sent.map((tx) => tx.nonce)).to.deep.equal([16, 19]);
            expect(hash).to.equal(chain.sent[1].hash);
            expect(leasesInFlight(key)).to.equal(0);
        });

        it('bridge deposit skips a provider refusing the pending nonce and the nonces the key used elsewhere', async () => {
            const key = generatePrivateKey();
            const chain = await chainFor(key, () => 'mine', SEPOLIA_ID);
            await bridgeVia(chain.url, key);
            chain.sendElsewhere(2);
            const refusing = await providerFor(chain, refusePendingNonce);

            const hash = await bridgeVia([refusing, chain.url], key);

            expect(chain.sent.map((tx) => tx.nonce)).to.deep.equal([16, 19]);
            expect(hash).to.equal(chain.sent[1].hash);
            expect(leasesInFlight(key, SEPOLIA_ID)).to.equal(0);
        });
    });

    describe('never return a foreign tx that took their nonce', () => {
        it('multi_send re-signs on a fresh nonce and returns its own hash', async () => {
            const key = generatePrivateKey();
            const chain = await chainFor(key, (index) => (index === 0 ? 'foreign' : 'mine'));

            const hash = await multiSendVia(chain.url, key);

            expect(chain.sent.map((tx) => tx.nonce)).to.deep.equal([16, 17]);
            expect(hash).to.equal(chain.sent[1].hash).and.not.equal(chain.foreign[0]);
            expect(alerts).to.have.length(1);
            expect(alerts[0]).to.contain('Type: Multi Send transaction').and.contain(hash).and.not.contain(chain.foreign[0]);
            expect(leasesInFlight(key)).to.equal(0);
        });

        it('multi_send fails once every fresh nonce is taken as well', async () => {
            const key = generatePrivateKey();
            const chain = await chainFor(key, () => 'foreign');

            const error = await captureError(() => multiSendVia(chain.url, key));

            expect(chain.sent.map((tx) => tx.nonce)).to.deep.equal([16, 17, 18, 19]);
            expect(error.message).to.contain('(multi-send)').and.contain(chain.foreign[3]).and.contain('can never be mined');
            expect(alerts).to.have.length(1);
            expect(alerts[0]).to.contain('Type: Error');
            expect(leasesInFlight(key)).to.equal(0);
        });

        it('multi_send accepts the receipt of its own earlier fee-bump attempt', async () => {
            const key = generatePrivateKey();
            // the node turns the first attempt down but it still gets mined, while the fee bump stays pending
            const refusedButMined: Fate = { refuse: 'replacement transaction underpriced', mined: true };
            const chain = await chainFor(key, (index) => (index === 0 ? refusedButMined : 'pending'));

            const hash = await multiSendVia(chain.url, key);

            expect(chain.sent.map((tx) => tx.nonce)).to.deep.equal([16, 16]);
            expect(chain.sent[1].hash).to.not.equal(chain.sent[0].hash);
            expect(hash).to.equal(chain.sent[0].hash);
            expect(alerts).to.have.length(1);
            expect(alerts[0]).to.contain('Type: Multi Send transaction').and.contain(hash);
            expect(leasesInFlight(key)).to.equal(0);
        });

        it('multi_send sent without waiting alerts an error, not a success, and resyncs the nonce', async () => {
            const key = generatePrivateKey();
            const chain = await chainFor(key, () => 'foreign');

            const hash = await multiSendVia(chain.url, key, false);

            await waitFor(() => alerts.length > 0 && allocatorState(senderOf(key), BASE_SEPOLIA_ID)?.needsResync === true);
            expect(hash).to.equal(chain.sent[0].hash);
            expect(alerts).to.have.length(1);
            expect(alerts[0]).to.contain('Type: Error').and.contain(chain.foreign[0]);
            expect(leasesInFlight(key)).to.equal(0);
        });

        it('batch_send re-signs on a fresh nonce and returns its own hash', async () => {
            const key = generatePrivateKey();
            const chain = await chainFor(key, (index) => (index === 0 ? 'foreign' : 'mine'));

            const hash = await batchSendVia(chain.url, key);

            expect(chain.sent.map((tx) => tx.nonce)).to.deep.equal([16, 17]);
            expect(hash).to.equal(chain.sent[1].hash).and.not.equal(chain.foreign[0]);
            expect(alerts).to.have.length(1);
            expect(alerts[0]).to.contain(hash).and.not.contain(chain.foreign[0]);
            expect(leasesInFlight(key)).to.equal(0);
        });

        it('batch_send fails once every fresh nonce is taken as well', async () => {
            const key = generatePrivateKey();
            const chain = await chainFor(key, () => 'foreign');

            const error = await captureError(() => batchSendVia(chain.url, key));

            expect(chain.sent.map((tx) => tx.nonce)).to.deep.equal([16, 17, 18, 19]);
            expect(error.message).to.contain('BATCH_SEND failed').and.contain('can never be mined');
            expect(alerts).to.have.length(1);
            expect(alerts[0]).to.contain('Type: Error');
            expect(leasesInFlight(key)).to.equal(0);
        });

        it('payout re-signs on a fresh nonce and returns its own hash', async () => {
            const key = generatePrivateKey();
            const chain = await chainFor(key, (index) => (index === 0 ? 'foreign' : 'mine'));

            const hash = await payoutVia(chain.url, key);

            expect(chain.sent.map((tx) => tx.nonce)).to.deep.equal([16, 17]);
            expect(hash).to.equal(chain.sent[1].hash).and.not.equal(chain.foreign[0]);
            expect(alerts).to.have.length(1);
            expect(alerts[0]).to.contain('Type: EVM transaction').and.contain(hash);
            expect(leasesInFlight(key)).to.equal(0);
        });

        it('payout fails once every fresh nonce is taken as well', async () => {
            const key = generatePrivateKey();
            const chain = await chainFor(key, () => 'foreign');

            const error = await captureError(() => payoutVia(chain.url, key));

            expect(chain.sent.map((tx) => tx.nonce)).to.deep.equal([16, 17, 18, 19]);
            expect(error).to.be.instanceOf(EvmNonceTakenError);
            expect(error.foreignTxHash).to.equal(chain.foreign[3]);
            expect(alerts).to.have.length(1);
            expect(alerts[0]).to.contain('Type: Error').and.contain(chain.foreign[3]);
            expect(leasesInFlight(key)).to.equal(0);
        });

        it('bridge deposit re-signs on a fresh nonce and returns its own hash', async () => {
            const key = generatePrivateKey();
            const chain = await chainFor(key, (index) => (index === 0 ? 'foreign' : 'mine'), SEPOLIA_ID);

            const hash = await bridgeVia(chain.url, key);

            expect(chain.sent.map((tx) => tx.nonce)).to.deep.equal([16, 17]);
            expect(hash).to.equal(chain.sent[1].hash).and.not.equal(chain.foreign[0]);
            expect(leasesInFlight(key, SEPOLIA_ID)).to.equal(0);
        });
    });
});

describe('assertOwnReceipt', () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const FOREIGN = `0x${'cd'.repeat(32)}` as Hex;
    const sign = (gasPrice: bigint) => account.signTransaction({
        chainId: BASE_SEPOLIA_ID, to: PAYEE, value: 1n, gas: 21000n, gasPrice, nonce: 7
    });
    const receiptOf = (transactionHash: string) => ({ transactionHash, status: 'success' }) as any;

    it('accepts the receipt of the signed tx and of an earlier attempt signed for the same request', async () => {
        const [first, bumped] = await Promise.all([sign(1n), sign(2n)]);
        const firstUpperCase = `0x${keccak256(first).slice(2).toUpperCase()}`;

        expect(() => assertOwnReceipt(receiptOf(keccak256(bumped)), bumped)).to.not.throw();
        expect(() => assertOwnReceipt(receiptOf(firstUpperCase), bumped, new Set([keccak256(first)]))).to.not.throw();
    });

    it('throws EvmNonceTakenError with both hashes and the nonce for a receipt of any other tx', async () => {
        const [first, bumped] = await Promise.all([sign(1n), sign(2n)]);

        const error = await captureError(async () => assertOwnReceipt(receiptOf(FOREIGN), bumped, new Set([keccak256(first)])));

        expect(error).to.be.instanceOf(EvmNonceTakenError);
        expect(error.foreignTxHash).to.equal(FOREIGN);
        expect(error.txHash).to.equal(keccak256(bumped));
        expect(error.nonce).to.equal(7);
    });

    it('is final: no send loop fails it over, bumps its fees or recovers it as an already known tx', () => {
        const error = new EvmNonceTakenError(`0x${'ab'.repeat(32)}`, FOREIGN, 16);
        const message = error.message.toLowerCase();

        expect(isEvmNetworkError(error)).to.equal(false);
        expect(isEvmProviderError(error)).to.equal(false);
        expect(isEvmAlreadyKnownError(error)).to.equal(false);
        expect([...Const.FEE_BUMP_ERROR_PATTERNS, ...Const.MINIMUM_TIP_ERROR_PATTERNS].some((p) => message.includes(p))).to.equal(false);
    });

    it('survives the JSON.stringify of the EVM error alert', () => {
        const error = new EvmNonceTakenError(`0x${'ab'.repeat(32)}`, FOREIGN, 16);

        expect(JSON.stringify(error)).to.contain(FOREIGN).and.contain('did not sign');
    });
});

describe('nonce allocator', () => {
    // pending nonce the node reports for every sender, null refuses the read
    let pending: number | null;
    let node: { url: string; close: () => Promise<void> };
    let client: PublicClient;

    // fresh sender per case: the allocator is process-wide and keyed by chain + address
    const newSender = () => senderOf(generatePrivateKey());
    const reserve = (sender: Address, fallbackToCache?: boolean) => (
        nonceAllocator.reserveNonce(client, sender, BASE_SEPOLIA_ID, fallbackToCache)
    );

    beforeEach(async () => {
        pending = START_NONCE;
        node = await startRpc(() => (pending === null
            ? { error: { code: 1, message: 'pending nonce refused' } }
            : { result: numberToHex(pending) }));
        client = createPublicClient({ chain: baseSepolia, transport: http(node.url) }) as PublicClient;
    });

    afterEach(() => node.close());

    it('jumps to the pending nonce of the node once the key sent outside this process', async () => {
        const sender = newSender();
        const first = await reserve(sender);
        await first.release(true);
        pending = START_NONCE + 4;

        const next = await reserve(sender);

        expect([first.nonce, next.nonce]).to.deep.equal([16, 20]);
        await next.release(true);
    });

    it('keeps its cache when the node reports a lower pending nonce', async () => {
        const sender = newSender();
        // the node never sees our txs, as a lagging one would
        const first = await reserve(sender);
        const second = await reserve(sender);
        await Promise.all([first.release(true), second.release(true)]);

        const third = await reserve(sender);

        expect([first.nonce, second.nonce, third.nonce]).to.deep.equal([16, 17, 18]);
        await third.release(true);
    });

    it('uses its cache when the pending read fails, and throws when it has none', async () => {
        const sender = newSender();
        pending = null;
        const withoutCache = await captureError(() => reserve(sender));
        pending = START_NONCE;
        const first = await reserve(sender);
        await first.release(true);
        pending = null;

        const cached = await reserve(sender);
        const notAllowed = await captureError(() => reserve(sender, false));

        expect(withoutCache.message).to.contain('pending nonce refused');
        expect(cached.nonce).to.equal(17);
        expect(notAllowed.message).to.contain('pending nonce refused');
        await cached.release(true);
    });

    it('resyncs to a lower pending nonce after a failed send, once nothing is in flight', async () => {
        const sender = newSender();
        const first = await reserve(sender);
        const second = await reserve(sender);
        // never broadcast: the node still reports the first nonce as pending
        await second.release(false);
        const third = await reserve(sender);
        await Promise.all([first.release(false), third.release(false)]);

        const fresh = await reserve(sender);

        expect([first.nonce, second.nonce, third.nonce, fresh.nonce]).to.deep.equal([16, 17, 18, 16]);
        expect(allocatorState(sender, BASE_SEPOLIA_ID)?.needsResync).to.equal(false);
        await fresh.release(true);
    });

    it('keeps a resync for the next read when the pending read fails', async () => {
        const sender = newSender();
        const first = await reserve(sender);
        await first.release(false);
        pending = null;
        const cached = await reserve(sender);
        await cached.release(false);
        pending = START_NONCE;

        const fresh = await reserve(sender);

        expect([first.nonce, cached.nonce, fresh.nonce]).to.deep.equal([16, 17, 16]);
        await fresh.release(true);
    });

    it('counts only the first release of a lease, so a repeated one cannot drop the same nonce leased again', async () => {
        const sender = newSender();
        const first = await reserve(sender);
        await first.release(false);
        const second = await reserve(sender);
        await first.release(false);

        expect(second.nonce).to.equal(first.nonce);
        expect(allocatorState(sender, BASE_SEPOLIA_ID)?.inFlight.size).to.equal(1);
        await second.release(true);
    });
});
