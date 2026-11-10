import 'mocha';
import bs58 from 'bs58';
import { expect } from 'chai';
import { AddressInfo } from 'net';
import { createServer, type Server } from 'http';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { decodeFunctionData, encodeAbiParameters, getContractAddress, keccak256, numberToHex, parseTransaction, type Abi, type Hex } from 'viem';
import { Keypair, SystemInstruction, Transaction, SystemProgram } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

import { createApp } from '../../api/app';
import { modules } from '../../utils/modules';
import { Const } from '../../constants/const';
import { failedTrc20Transfer } from '../../scenarios/tron.scenarios';
import { failedSolanaTransfer, token2022TransferFee, type SolanaChain } from '../../scenarios/solana.scenarios';

const BASE_SEPOLIA_ID = 84532;
const BLOCK = '0x8adc40';
const BLOCK_HASH = `0x${'ef'.repeat(32)}`;
const TRANSFER_ABI = [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }] as const satisfies Abi;

interface ChainOptions {
    /** transactions to these addresses are mined with status 0 */
    revertTo?: string[];
    /** 'replace': a same-nonce tx replaces the pending one; 'first_wins': it is refused, the first one is mined */
    sameNonce?: 'replace' | 'first_wins';
}

async function startChain(sender: string, options: ChainOptions = {}) {
    const byNonce = new Map<number, any>();
    const byHash = new Map<string, any>();
    const broadcasts: Hex[] = [];
    const START = 7;
    const revertTo = new Set((options.revertTo ?? []).map((a) => a.toLowerCase()));

    const handle = (method: string, params: any[]): { result?: unknown; error?: unknown } => {
        switch (method) {
            case 'eth_chainId': return { result: numberToHex(BASE_SEPOLIA_ID) };
            case 'eth_blockNumber': return { result: BLOCK };
            case 'eth_gasPrice': return { result: '0x5b8d80' };
            case 'eth_maxPriorityFeePerGas': return { result: '0x5f5e100' };
            case 'eth_estimateGas': return { result: numberToHex(60000) };
            case 'eth_call': {
                const selector = params[0].data.slice(0, 10);
                if (selector === '0x70a08231') return { result: encodeAbiParameters([{ type: 'uint256' }], [1000000n]) }; // balanceOf: 1.0 at 6 decimals
                if (selector === '0x313ce567') return { result: encodeAbiParameters([{ type: 'uint8' }], [6]) };
                if (selector === '0x06fdde03') return { result: encodeAbiParameters([{ type: 'string' }], ['Tether USD']) };
                if (selector === '0x95d89b41') return { result: encodeAbiParameters([{ type: 'string' }], ['USDT']) };
                return { result: '0x' };
            }
            case 'eth_getTransactionCount': return { result: numberToHex(START + byNonce.size) };
            case 'eth_getBlockByNumber':
                return { result: { number: BLOCK, hash: BLOCK_HASH, timestamp: '0x6720f000', gasLimit: '0x1c9c380', gasUsed: '0x0', baseFeePerGas: '0x3b9aca00', transactions: [] } };
            case 'eth_getTransactionByHash': return { result: byHash.get(params[0]) ?? null };
            case 'eth_getTransactionReceipt': {
                const tx = byHash.get(params[0]);
                if (!tx || byNonce.get(Number(tx.nonce))?.hash !== tx.hash) return { result: null };
                return {
                    result: {
                        transactionHash: tx.hash, transactionIndex: '0x0', blockHash: BLOCK_HASH, blockNumber: BLOCK, from: sender.toLowerCase(), to: tx.to,
                        cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x5b8d80', contractAddress: tx.created ?? null,
                        logs: [], logsBloom: `0x${'00'.repeat(256)}`, status: tx.to && revertTo.has(tx.to) ? '0x0' : '0x1', type: '0x2'
                    }
                };
            }
            case 'eth_sendRawTransaction': {
                const raw = params[0] as Hex;
                const parsed = parseTransaction(raw);
                const nonce = parsed.nonce ?? 0;
                if (byNonce.has(nonce) && options.sameNonce === 'first_wins') return { error: { code: -32000, message: 'nonce too low' } };
                const hash = keccak256(raw);
                const tx = {
                    hash, from: sender.toLowerCase(), to: parsed.to?.toLowerCase() ?? null, nonce: numberToHex(nonce), value: numberToHex(parsed.value ?? 0n),
                    created: parsed.to ? null : getContractAddress({ from: sender as Hex, nonce: BigInt(nonce) }),
                    input: parsed.data ?? '0x', gas: numberToHex(parsed.gas ?? 0n), chainId: numberToHex(BASE_SEPOLIA_ID), type: '0x2', gasPrice: '0x5b8d80',
                    blockHash: BLOCK_HASH, blockNumber: BLOCK, transactionIndex: '0x0', v: '0x0', r: '0x1', s: '0x1'
                };
                broadcasts.push(raw);
                byNonce.set(nonce, tx);
                byHash.set(hash, tx);
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
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, broadcasts, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }) };
}

describe('deposit test scenarios', () => {
    const providers = { ...Const.EVM_RPC_PROVIDERS };
    const { sendMessageToTelegram } = modules;
    const key = generatePrivateKey();
    const sender = privateKeyToAccount(key).address;
    const PAYEE = privateKeyToAccount(generatePrivateKey()).address;
    const TOKEN = privateKeyToAccount(generatePrivateKey()).address;
    let app: Server;
    let baseUrl: string;

    before(async () => {
        modules.sendMessageToTelegram = async () => undefined;
        app = createApp().listen(0);
        await new Promise((resolve) => app.once('listening', resolve));
        baseUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    });

    after(async () => {
        Object.assign(Const.EVM_RPC_PROVIDERS, providers);
        modules.sendMessageToTelegram = sendMessageToTelegram;
        await new Promise((resolve) => app.close(resolve));
    });

    async function post(path: string, data: Record<string, unknown>) {
        const response = await fetch(`${baseUrl}${path}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }), signal: AbortSignal.timeout(30000)
        });
        return { status: response.status, body: await response.json() };
    }

    describe('EVM', () => {
        it('reverted_transfer: mines a transfer above the balance that reverts', async () => {
            const chain = await startChain(sender, { revertTo: [TOKEN] });
            Const.EVM_RPC_PROVIDERS.base_eth = [chain.url];
            try {
                const res = await post('/scenario/evm/reverted_transfer', { payway: 'base_eth', private_key: key, payee_address: PAYEE, contract: TOKEN, amount: '5' });

                expect(res.status).to.equal(200);
                expect(res.body).to.deep.include({ scenario: 'evm/reverted_transfer' });
                expect(res.body.expected).to.contain('not credited');
                const sent = parseTransaction(chain.broadcasts[chain.broadcasts.length - 1]);
                const call = decodeFunctionData({ abi: TRANSFER_ABI, data: sent.data as Hex });
                // balance 1.0 + 5.0 at 6 decimals: always above what the sender holds
                expect(call.args).to.deep.equal([PAYEE, 6000000n]);
                expect(res.body.tx_id).to.equal(keccak256(chain.broadcasts[chain.broadcasts.length - 1]));
            } finally {
                await chain.close();
            }
        });

        it('lookalike_token: deploys a copy with the same metadata and transfers it', async () => {
            const chain = await startChain(sender);
            Const.EVM_RPC_PROVIDERS.base_eth = [chain.url];
            try {
                const res = await post('/scenario/evm/lookalike_token', { payway: 'base_eth', private_key: key, payee_address: PAYEE, original_contract: TOKEN, amount: '3' });

                expect(res.status).to.equal(200);
                expect(res.body.details).to.deep.include({ original_contract: TOKEN, name: 'Tether USD', symbol: 'USDT', decimals: 6 });
                const deploy = parseTransaction(chain.broadcasts[0]);
                const transfer = parseTransaction(chain.broadcasts[1]);
                expect(deploy.to).to.equal(undefined);
                expect(transfer.to?.toLowerCase()).to.equal(res.body.details.fake_contract.toLowerCase());
                expect(decodeFunctionData({ abi: TRANSFER_ABI, data: transfer.data as Hex }).args).to.deep.equal([PAYEE, 3000000n]);
            } finally {
                await chain.close();
            }
        });

        it('replaced_transfer: reports the cancel replacing the transfer', async () => {
            const chain = await startChain(sender, { sameNonce: 'replace' });
            Const.EVM_RPC_PROVIDERS.base_eth = [chain.url];
            try {
                const res = await post('/scenario/evm/replaced_transfer', { payway: 'base_eth', private_key: key, payee_address: PAYEE, amount: '0.001' });

                expect(res.status).to.equal(200);
                expect(res.body.details.outcome).to.equal('replaced');
                const [original, cancel] = chain.broadcasts.map((raw) => parseTransaction(raw));
                expect(original.nonce).to.equal(cancel.nonce);
                expect(original.to?.toLowerCase()).to.equal(PAYEE.toLowerCase());
                expect(cancel.to?.toLowerCase()).to.equal(sender.toLowerCase());
                expect(cancel.value ?? 0n).to.equal(0n);
                expect((cancel.maxFeePerGas as bigint) > (original.maxFeePerGas as bigint)).to.equal(true);
            } finally {
                await chain.close();
            }
        });

        it('replaced_transfer: reports the original mined when the chain was faster than the cancel', async () => {
            const chain = await startChain(sender, { sameNonce: 'first_wins' });
            Const.EVM_RPC_PROVIDERS.base_eth = [chain.url];
            try {
                const res = await post('/scenario/evm/replaced_transfer', { payway: 'base_eth', private_key: key, payee_address: PAYEE, amount: '0.001' });

                expect(res.status).to.equal(200);
                expect(res.body.details.outcome).to.equal('original_mined');
                expect(res.body.expected).to.contain('credited once');
            } finally {
                await chain.close();
            }
        });

        it('validates scenario requests', async () => {
            const res = await post('/scenario/evm/reverted_transfer', { payway: 'base_eth', private_key: key, payee_address: PAYEE, amount: '1' });

            expect(res.status).to.equal(400);
            expect(res.body.details[0].path).to.equal('data.contract');
        });
    });

    describe('Tron', () => {
        const fakeTronWeb = (info: unknown) => ({
            toUtf8: (hex: string) => Buffer.from(hex, 'hex').toString('utf8'),
            trx: { getUnconfirmedTransactionInfo: async () => info },
            contract: () => ({
                at: async () => ({
                    decimals: () => ({ call: async () => 6 }),
                    transfer: () => ({ send: async (options: { feeLimit: number }) => { (fakeTronWeb as any).lastFeeLimit = options.feeLimit; return 'ab'.repeat(32); } })
                })
            })
        });
        const input = { payway: 'trc20', privateKey: generatePrivateKey().slice(2), payee: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', amount: '1' };

        it('failed_trc20: reports the transfer that ran out of energy', async () => {
            const result = await failedTrc20Transfer(input, fakeTronWeb({ blockNumber: 1, result: 'FAILED', receipt: { result: 'OUT_OF_ENERGY' } }));

            expect(result.scenario).to.equal('tron/failed_trc20');
            expect(result.details).to.deep.include({ result: 'OUT_OF_ENERGY', fee_limit_sun: 1000000 });
            expect((fakeTronWeb as any).lastFeeLimit).to.equal(1000000);
        });

        it('failed_trc20: says so when the transfer succeeded instead', async () => {
            const error = await failedTrc20Transfer(input, fakeTronWeb({ blockNumber: 1, receipt: { result: 'SUCCESS' } })).catch((e) => e);

            expect(error).to.include({ status: 422, code: 'scenario_not_reproduced' });
        });
    });

    describe('Solana', () => {
        const payer = Keypair.generate();
        const payee = Keypair.generate().publicKey.toBase58();

        it('failed_transfer: sends more SOL than held, without preflight, and reports the error', async () => {
            const sent: Buffer[] = [];
            let preflightSkipped = false;
            const chain = {
                connection: {
                    getBalance: async () => 2000000000,
                    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
                    sendRawTransaction: async (raw: Buffer, options: { skipPreflight: boolean }) => { sent.push(raw); preflightSkipped = options.skipPreflight; return 'sig1'; },
                    confirmTransaction: async () => ({ value: { err: { InstructionError: [0, { Custom: 1 }] } } })
                },
                sendAndConfirm: async () => 'unused'
            } as unknown as SolanaChain;

            const result = await failedSolanaTransfer({ privateKey: bs58.encode(payer.secretKey), payee, amount: '0.5' }, chain);

            expect(result).to.deep.include({ scenario: 'solana/failed_transfer', txId: 'sig1' });
            expect(preflightSkipped).to.equal(true);
            const tx = Transaction.from(sent[0]);
            expect(tx.instructions[0].programId.equals(SystemProgram.programId)).to.equal(true);
            expect(SystemInstruction.decodeTransfer(tx.instructions[0]).lamports).to.equal(2500000000n);
        });

        it('token2022_transfer_fee: creates a fee mint and transfers with the fee the program expects', async () => {
            const txs: Transaction[] = [];
            const chain = {
                connection: { getMinimumBalanceForRentExemption: async () => 2039280 },
                sendAndConfirm: async (tx: Transaction) => { txs.push(tx); return `sig${txs.length}`; }
            } as unknown as SolanaChain;

            const result = await token2022TransferFee({ privateKey: bs58.encode(payer.secretKey), payee, amount: '100', feeBasisPoints: 150 }, chain);

            expect(txs).to.have.length(2);
            expect(txs[0].instructions.map((i) => i.programId.toBase58())).to.deep.equal([
                SystemProgram.programId.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()
            ]);
            expect(txs[1].instructions.slice(2).every((i) => i.programId.equals(TOKEN_2022_PROGRAM_ID))).to.equal(true);
            expect(result.details).to.deep.include({ mint_created: true, decimals: 6, fee_basis_points: 150, sent: '100', fee: '1.5', received: '98.5' });
            expect(result.txId).to.equal('sig2');
        });
    });
});
