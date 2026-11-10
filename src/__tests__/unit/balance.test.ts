import 'mocha';
import { expect } from 'chai';
import { AddressInfo } from 'net';
import { createServer, type Server } from 'http';
import { encodeAbiParameters, numberToHex } from 'viem';
import { Keypair } from '@solana/web3.js';

import { createApp } from '../../api/app';
import { Const } from '../../constants/const';
import { solanaBalance, tronBalance, type Balance } from '../../services/balance.service';
import { BalanceWatcher, startBalanceWatcherFromEnv } from '../../balance/watcher';

const OWNER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const TOKEN = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';

async function listen(handler: (body: any) => unknown): Promise<{ url: string; close: () => Promise<void> }> {
    const server: Server = createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            const reply = handler(JSON.parse(raw));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(reply));
        });
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => new Promise<void>((resolve) => { server.close(() => resolve()); })
    };
}

describe('balances', () => {
    let app: Server;
    let baseUrl: string;
    let evmNode: { url: string; close: () => Promise<void> };
    let ltcNode: { url: string; close: () => Promise<void> };
    const providers = { ...Const.EVM_RPC_PROVIDERS };

    before(async () => {
        evmNode = await listen(({ id, method, params }) => {
            if (method === 'eth_chainId') return { jsonrpc: '2.0', id, result: numberToHex(84532) };
            if (method === 'eth_getBalance') return { jsonrpc: '2.0', id, result: numberToHex(1500000000000000000n) };
            if (method === 'eth_call') {
                const selector = params[0].data.slice(0, 10);
                if (selector === '0x70a08231') return { jsonrpc: '2.0', id, result: encodeAbiParameters([{ type: 'uint256' }], [2500000n]) }; // balanceOf
                if (selector === '0x313ce567') return { jsonrpc: '2.0', id, result: encodeAbiParameters([{ type: 'uint8' }], [6]) }; // decimals
                if (selector === '0x95d89b41') return { jsonrpc: '2.0', id, result: encodeAbiParameters([{ type: 'string' }], ['USDT']) }; // symbol
            }
            return { jsonrpc: '2.0', id, error: { code: -32601, message: `${method} not mocked` } };
        });
        ltcNode = await listen(({ id, method }) => (method === 'getbalance'
            ? { id, result: 1.23456789, error: null }
            : { id, result: null, error: { code: -32601, message: 'not mocked' } }));

        Const.EVM_RPC_PROVIDERS.base_eth = [evmNode.url];
        process.env.RPC_URL = ltcNode.url;
        process.env.RPC_USER = 'user';
        process.env.RPC_PASS = 'pass';

        app = createApp().listen(0);
        await new Promise((resolve) => app.once('listening', resolve));
        baseUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    });

    after(async () => {
        Object.assign(Const.EVM_RPC_PROVIDERS, providers);
        process.env.RPC_URL = '';
        process.env.RPC_USER = '';
        process.env.RPC_PASS = '';
        await new Promise((resolve) => app.close(resolve));
        await evmNode.close();
        await ltcNode.close();
    });

    async function get(path: string) {
        const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(10000) });
        return { status: response.status, body: await response.json() };
    }

    describe('GET /balance', () => {
        it('reads a native EVM balance', async () => {
            const res = await get(`/balance?payway=base_eth&address=${OWNER}`);

            expect(res.status).to.equal(200);
            expect(res.body).to.deep.include({ chain: 'evm', balance: '1.5', raw: '1500000000000000000', decimals: 18, symbol: 'ETH', token: null });
        });

        it('reads an ERC20 balance with the token decimals and symbol', async () => {
            const res = await get(`/balance?payway=base_eth&address=${OWNER}&token=${TOKEN}`);

            expect(res.body).to.deep.include({ balance: '2.5', raw: '2500000', decimals: 6, symbol: 'USDT', token: TOKEN });
        });

        it('reads the Litecoin node wallet balance', async () => {
            const res = await get('/balance?payway=ltc');

            expect(res.body).to.deep.include({ chain: 'ltc', balance: '1.23456789', raw: '123456789', decimals: 8, symbol: 'LTC' });
        });

        it('refuses a Litecoin address, the node only knows its own wallet', async () => {
            const res = await get('/balance?payway=ltc&address=tltc1qsomething');

            expect(res.status).to.equal(400);
        });

        it('answers bad input with a 400 naming it', async () => {
            expect((await get('/balance')).status).to.equal(400);
            expect((await get(`/balance?payway=dogecoin&address=${OWNER}`)).body.error).to.contain('Unsupported payway for balances');
            expect((await get('/balance?payway=base_eth&address=0x123')).body.error).to.contain('not a valid EVM address');
            expect((await get('/balance?payway=base_eth')).status).to.equal(400);
        });

        it('reports the watcher as off when BALANCE_WATCH is not set', async () => {
            const res = await get('/balance/watch');

            expect(res.body).to.deep.equal({ enabled: false, interval_minutes: null, wallets: [] });
        });
    });

    describe('Solana and Tron readers', () => {
        it('reads SOL and sums every token account of the mint', async () => {
            const owner = Keypair.generate().publicKey.toBase58();
            const mint = Keypair.generate().publicKey.toBase58();
            const connection: any = {
                getBalance: async () => 1500000000,
                getParsedTokenAccountsByOwner: async () => ({
                    value: [
                        { account: { data: { parsed: { info: { tokenAmount: { amount: '1000000', decimals: 6 } } } } } },
                        { account: { data: { parsed: { info: { tokenAmount: { amount: '250000', decimals: 6 } } } } } }
                    ]
                })
            };

            expect(await solanaBalance({ payway: 'sol', address: owner }, connection)).to.deep.include({ balance: '1.5', symbol: 'SOL' });
            expect(await solanaBalance({ payway: 'sol', address: owner, token: mint }, connection)).to.deep.include({ balance: '1.25', raw: '1250000', decimals: 6 });
        });

        it('reads TRX and a TRC20 balance through constant calls', async () => {
            const tronWeb: any = {
                setAddress: () => undefined,
                trx: { getBalance: async () => 2000000 },
                contract: () => ({
                    at: async () => ({
                        balanceOf: () => ({ call: async () => 3500000n }),
                        decimals: () => ({ call: async () => 6n }),
                        symbol: () => ({ call: async () => 'USDT' })
                    })
                })
            };

            expect(await tronBalance({ payway: 'tron', address: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf' }, tronWeb)).to.deep.include({ balance: '2', symbol: 'TRX' });
            expect(await tronBalance({ payway: 'trc20', address: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', token: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' }, tronWeb))
                .to.deep.include({ balance: '3.5', symbol: 'USDT', decimals: 6 });
        });
    });

    describe('BalanceWatcher', () => {
        const balanceOf = (raw: bigint): Balance => ({
            chain: 'evm', payway: 'base_eth', address: OWNER, token: null, symbol: 'ETH', decimals: 18, balance: (Number(raw) / 1e18).toString(), raw: raw.toString()
        });

        it('alerts once when a wallet drops below its minimum and once when it is back', async () => {
            const readings = [balanceOf(10n ** 18n), balanceOf(10n ** 16n), balanceOf(10n ** 16n), balanceOf(2n * 10n ** 18n)];
            const alerts: string[] = [];
            const watcher = new BalanceWatcher(
                [{ payway: 'base_eth', address: OWNER, min: '0.5', label: 'QA wallet' }],
                async () => readings.shift() as Balance,
                async (message) => { alerts.push(message); }
            );

            for (let i = 0; i < 4; i += 1) await watcher.checkAll();

            expect(alerts).to.have.length(2);
            expect(alerts[0]).to.contain('Low balance').and.contain('QA wallet').and.contain('0.5');
            expect(alerts[1]).to.contain('Balance restored');
        });

        it('treats a failed read as unknown, not as a low balance', async () => {
            const alerts: string[] = [];
            const watcher = new BalanceWatcher(
                [{ payway: 'base_eth', address: OWNER, min: '0.5' }],
                async () => { throw new Error('all providers down'); },
                async (message) => { alerts.push(message); }
            );

            await watcher.checkAll();

            expect(alerts).to.have.length(0);
            expect(watcher.status()[0]).to.deep.include({ low: false, error: 'all providers down' });
        });

        it('stays off with a broken BALANCE_WATCH instead of failing the start', () => {
            const previous = process.env.BALANCE_WATCH;
            process.env.BALANCE_WATCH = '{not json';
            try {
                expect(startBalanceWatcherFromEnv()).to.equal(undefined);
                process.env.BALANCE_WATCH = '[{"payway":"base_eth","min":"abc"}]';
                expect(startBalanceWatcherFromEnv()).to.equal(undefined);
            } finally {
                process.env.BALANCE_WATCH = previous;
            }
        });
    });
});
