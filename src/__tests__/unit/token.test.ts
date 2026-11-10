import 'mocha';
import { expect } from 'chai';
import { AddressInfo } from 'net';
import { createServer, type Server } from 'http';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { decodeFunctionData, encodeAbiParameters, getContractAddress, keccak256, numberToHex, parseTransaction, type Abi, type Hex } from 'viem';

import { createApp } from '../../api/app';
import { modules } from '../../utils/modules';
import { Const } from '../../constants/const';
import artifacts from '../../tokens/artifacts.json';
import { constructorArgs } from '../../services/token.service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sourcesHash, tokenSources } = require('../../../scripts/compile-tokens.js');

const BASE_SEPOLIA_ID = 84532;
const BLOCK = '0x8adc40';
const BLOCK_HASH = `0x${'cd'.repeat(32)}`;

/* Mock chain that mines every tx at once and gives contract creations their CREATE address */
async function startChain(sender: string, tokenDecimals: number) {
    const txs = new Map<string, any>();
    const broadcasts: Hex[] = [];
    let nonce = 3;

    const handle = (method: string, params: any[]): { result?: unknown; error?: unknown } => {
        switch (method) {
            case 'eth_chainId': return { result: numberToHex(BASE_SEPOLIA_ID) };
            case 'eth_blockNumber': return { result: BLOCK };
            case 'eth_gasPrice': return { result: '0x5b8d80' };
            case 'eth_maxPriorityFeePerGas': return { result: '0x5f5e100' };
            case 'eth_estimateGas': return { result: numberToHex(1500000) };
            case 'eth_call': return { result: encodeAbiParameters([{ type: 'uint8' }], [tokenDecimals]) };
            case 'eth_getTransactionCount': return { result: numberToHex(nonce) };
            case 'eth_getBlockByNumber':
                return { result: { number: BLOCK, hash: BLOCK_HASH, timestamp: '0x6720f000', gasLimit: '0x1c9c380', gasUsed: '0x0', baseFeePerGas: '0x3b9aca00', transactions: [] } };
            case 'eth_getTransactionByHash': return { result: txs.get(params[0]) ?? null };
            case 'eth_getTransactionReceipt': {
                const tx = txs.get(params[0]);
                if (!tx) return { result: null };
                return {
                    result: {
                        transactionHash: tx.hash, transactionIndex: '0x0', blockHash: BLOCK_HASH, blockNumber: BLOCK, from: sender.toLowerCase(), to: tx.to,
                        cumulativeGasUsed: '0x100000', gasUsed: '0x100000', effectiveGasPrice: '0x5b8d80', contractAddress: tx.created ?? null,
                        logs: [], logsBloom: `0x${'00'.repeat(256)}`, status: '0x1', type: '0x2'
                    }
                };
            }
            case 'eth_sendRawTransaction': {
                const raw = params[0] as Hex;
                const parsed = parseTransaction(raw);
                const hash = keccak256(raw);
                const created = parsed.to ? null : getContractAddress({ from: sender as Hex, nonce: BigInt(parsed.nonce ?? 0) });
                broadcasts.push(raw);
                nonce += 1;
                txs.set(hash, {
                    hash, from: sender.toLowerCase(), to: parsed.to?.toLowerCase() ?? null, created, nonce: numberToHex(parsed.nonce ?? 0), value: '0x0',
                    input: parsed.data ?? '0x', gas: numberToHex(parsed.gas ?? 0n), chainId: numberToHex(BASE_SEPOLIA_ID), type: '0x2',
                    blockHash: BLOCK_HASH, blockNumber: BLOCK, transactionIndex: '0x0', v: '0x0', r: '0x1', s: '0x1', gasPrice: '0x5b8d80'
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

describe('test token presets', () => {
    it('ships artifacts compiled from the current contract sources', () => {
        // fails when a .sol file changed without `npm run tokens:compile`
        expect(artifacts.sourcesHash).to.equal(sourcesHash(tokenSources()));
        expect(artifacts.settings.evmVersion).to.equal('cancun');
    });

    it('has the constructors and functions the service relies on', () => {
        const ctor = (preset: string) => ((artifacts.presets as any)[preset].abi as any[]).find((x) => x.type === 'constructor').inputs.map((i: any) => i.type);
        const fns = (preset: string) => ((artifacts.presets as any)[preset].abi as any[]).filter((x) => x.type === 'function').map((x) => x.name);

        expect(ctor('standard')).to.deep.equal(['string', 'string', 'uint8', 'uint256', 'address']);
        expect(ctor('faucet')).to.deep.equal(['string', 'string', 'uint8', 'uint256', 'address', 'uint256', 'uint256']);
        expect(ctor('advanced')).to.deep.equal(['string', 'string', 'uint8', 'uint256', 'address']);
        expect(fns('standard')).to.include.members(['mint', 'airdrop', 'burn', 'decimals', 'transfer']);
        expect(fns('faucet')).to.include.members(['claim', 'faucetAmount', 'faucetCooldown', 'lastClaim']);
        expect(fns('advanced')).to.include.members(['pause', 'unpause', 'permit', 'nonces']);
    });

    it('turns human amounts into base units for the constructor', () => {
        const owner = privateKeyToAccount(generatePrivateKey()).address;
        const input = { payway: 'eth', privateKey: '', name: 'Test USD', symbol: 'tUSD', decimals: 6, initialSupply: '1000' };

        expect(constructorArgs({ ...input, preset: 'standard' }, owner)).to.deep.equal(['Test USD', 'tUSD', 6, 1000000000n, owner]);
        expect(constructorArgs({ ...input, preset: 'faucet', faucetAmount: '10' }, owner)).to.deep.equal(['Test USD', 'tUSD', 6, 1000000000n, owner, 10000000n, 86400n]);
    });
});

describe('token routes end to end', () => {
    let app: Server;
    let baseUrl: string;
    let chain: Awaited<ReturnType<typeof startChain>>;
    const key = generatePrivateKey();
    const sender = privateKeyToAccount(key).address;
    const providers = { ...Const.EVM_RPC_PROVIDERS };
    const { sendMessageToTelegram } = modules;

    before(async () => {
        modules.sendMessageToTelegram = async () => undefined;
        chain = await startChain(sender, 6);
        Const.EVM_RPC_PROVIDERS.base_eth = [chain.url];
        app = createApp().listen(0);
        await new Promise((resolve) => app.once('listening', resolve));
        baseUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    });

    after(async () => {
        Object.assign(Const.EVM_RPC_PROVIDERS, providers);
        modules.sendMessageToTelegram = sendMessageToTelegram;
        await new Promise((resolve) => app.close(resolve));
        await chain.close();
    });

    async function post(path: string, data: Record<string, unknown>) {
        const response = await fetch(`${baseUrl}${path}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }), signal: AbortSignal.timeout(20000)
        });
        return { status: response.status, body: await response.json() };
    }

    it('deploys a preset and answers the contract address', async () => {
        const res = await post('/token/evm/deploy', { payway: 'base_eth', private_key: key, preset: 'faucet', name: 'Test USD', symbol: 'tUSD', decimals: 6, initial_supply: '1000', faucet_amount: '10' });

        expect(res.status).to.equal(200);
        const sent = parseTransaction(chain.broadcasts[chain.broadcasts.length - 1]);
        expect(sent.to).to.equal(undefined);
        expect(sent.data?.startsWith(artifacts.presets.faucet.bytecode)).to.equal(true);
        expect(res.body).to.deep.include({
            tx_id: keccak256(chain.broadcasts[chain.broadcasts.length - 1]),
            contract_address: getContractAddress({ from: sender, nonce: BigInt(sent.nonce ?? 0) }),
            preset: 'faucet',
            decimals: 6,
            owner: sender
        });
    });

    it('replays a deploy by request_id with the same address, deploying nothing new', async () => {
        const data = { payway: 'base_eth', private_key: key, name: 'Replay', symbol: 'RPL', request_id: `token-${Date.now()}` };

        const first = await post('/token/evm/deploy', data);
        const before = chain.broadcasts.length;
        const retry = await post('/token/evm/deploy', data);

        expect(retry.body).to.deep.equal(first.body);
        expect(chain.broadcasts.length).to.equal(before);
    });

    it('mints with the token decimals', async () => {
        const contract = privateKeyToAccount(generatePrivateKey()).address;
        const to = privateKeyToAccount(generatePrivateKey()).address;

        const res = await post('/token/evm/mint', { payway: 'base_eth', private_key: key, contract, to, amount: '2' });

        expect(res.status).to.equal(200);
        const sent = parseTransaction(chain.broadcasts[chain.broadcasts.length - 1]);
        expect(sent.to?.toLowerCase()).to.equal(contract.toLowerCase());
        const call = decodeFunctionData({ abi: artifacts.presets.standard.abi as Abi, data: sent.data as Hex });
        expect(call.functionName).to.equal('mint');
        expect(call.args).to.deep.equal([to, 2000000n]);
    });

    it('rejects a faucet deploy without faucet_amount and an empty symbol', async () => {
        const faucet = await post('/token/evm/deploy', { payway: 'base_eth', private_key: key, preset: 'faucet', name: 'X', symbol: 'X' });
        const empty = await post('/token/evm/deploy', { payway: 'base_eth', private_key: key, name: 'X', symbol: '' });

        expect(faucet.status).to.equal(400);
        expect(faucet.body.details[0].path).to.equal('data.faucet_amount');
        expect(empty.status).to.equal(400);
    });
});
