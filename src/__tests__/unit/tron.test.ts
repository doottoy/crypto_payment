import 'mocha';
import { expect } from 'chai';

import { Const } from '../../constants/const';
import { modules } from '../../utils/modules';
import { toErrorResponse } from '../../api/errors';
import { runPayout } from '../../payouts/run';
import { PayoutStore, setPayoutStore } from '../../payouts/store';
import { TronPayoutService } from '../../services/tron.payout.service';
import { TronMultiPayoutService } from '../../services/tron.multi-payout.service';
import { TronConfirmationTimeoutError, TronExecutionFailedError, waitForTronExecution } from '../../utils/tron-broadcast';

/* Shapes copied from real Nile answers to gettransactioninfobyid */
const IN_BLOCK_SUCCESS = { id: 'x', blockNumber: 72594024, receipt: { energy_usage_total: 108000, net_usage: 987, result: 'SUCCESS' }, contractResult: [''] };
const IN_BLOCK_NATIVE = { id: 'x', blockNumber: 72594024, receipt: { net_usage: 270 }, contractResult: [''] };
const IN_BLOCK_REVERT = {
    id: 'x', blockNumber: 72594021, result: 'FAILED', resMessage: '524556455254206f70636f6465206578656375746564',
    receipt: { energy_usage_total: 2719, net_usage: 1018, result: 'REVERT' }, contractResult: ['08c379a0']
};
const IN_BLOCK_OUT_OF_ENERGY = { id: 'x', blockNumber: 72594030, result: 'FAILED', receipt: { result: 'OUT_OF_ENERGY' } };
const NOT_IN_BLOCK = {};

const TX = 'ab'.repeat(32);
const KEY = '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const PAYEE = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';
const TOKEN = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

function fakeTronWeb(infos: unknown[], decimals = 6) {
    let read = 0;
    const calls = { native: [] as unknown[][], transfer: [] as unknown[][], multiTrx: [] as unknown[][], multiToken: [] as unknown[][] };
    const tronWeb = {
        toUtf8: (hex: string) => Buffer.from(hex, 'hex').toString('utf8'),
        trx: {
            getUnconfirmedTransactionInfo: async () => {
                const info = infos[Math.min(read, infos.length - 1)];
                read += 1;
                if (info instanceof Error) throw info;
                return info;
            },
            sendTransaction: async (to: string, amount: string) => {
                calls.native.push([to, amount]);
                return { result: true, txid: TX };
            }
        },
        contract: () => ({
            at: async () => ({
                decimals: () => ({ call: async () => decimals }),
                transfer: (to: string, amount: string) => ({ send: async () => { calls.transfer.push([to, amount]); return TX; } }),
                multiTransferTrx: (to: string[], amounts: string[]) => ({ send: async () => { calls.multiTrx.push([to, amounts]); return TX; } }),
                multiTransferToken: (token: string, to: string[], amounts: string[]) => ({ send: async () => { calls.multiToken.push([token, to, amounts]); return TX; } })
            })
        })
    };
    return { tronWeb, calls, reads: () => read };
}

describe('Tron execution check', () => {
    const { sendMessageToTelegram } = modules;
    const pollMs = Const.TRON_CONFIRM_POLL_MS;
    const timeoutMs = Const.TRON_CONFIRM_TIMEOUT_MS;
    let alerts: string[];

    beforeEach(() => {
        alerts = [];
        modules.sendMessageToTelegram = async (message: string) => { alerts.push(message); };
        Const.TRON_CONFIRM_POLL_MS = 5;
        Const.TRON_CONFIRM_TIMEOUT_MS = 2000;
    });

    afterEach(() => {
        modules.sendMessageToTelegram = sendMessageToTelegram;
        Const.TRON_CONFIRM_POLL_MS = pollMs;
        Const.TRON_CONFIRM_TIMEOUT_MS = timeoutMs;
        setPayoutStore(undefined);
    });

    describe('waitForTronExecution', () => {
        it('waits until the transaction is in a block and executed', async () => {
            const fake = fakeTronWeb([NOT_IN_BLOCK, NOT_IN_BLOCK, IN_BLOCK_SUCCESS]);

            const verdict = await waitForTronExecution(fake.tronWeb, 'TRC20', TX);

            expect(verdict).to.deep.equal({ blockNumber: 72594024, result: 'SUCCESS' });
            expect(fake.reads()).to.equal(3);
        });

        it('takes inclusion as success for a native transfer, which has no receipt result', async () => {
            const verdict = await waitForTronExecution(fakeTronWeb([IN_BLOCK_NATIVE]).tronWeb, 'TRX', TX);

            expect(verdict.result).to.equal('SUCCESS');
        });

        it('fails a reverted call with the decoded node message', async () => {
            const error = await waitForTronExecution(fakeTronWeb([IN_BLOCK_REVERT]).tronWeb, 'TRC20', TX).catch((e) => e);

            expect(error).to.be.instanceOf(TronExecutionFailedError);
            expect(error).to.include({ txId: TX, result: 'REVERT', reason: 'REVERT opcode executed', blockNumber: 72594021 });
        });

        it('fails a call that ran out of energy', async () => {
            const error = await waitForTronExecution(fakeTronWeb([IN_BLOCK_OUT_OF_ENERGY]).tronWeb, 'TRC20', TX).catch((e) => e);

            expect(error).to.be.instanceOf(TronExecutionFailedError);
            expect(error.result).to.equal('OUT_OF_ENERGY');
        });

        it('keeps polling through failed reads', async () => {
            const verdict = await waitForTronExecution(fakeTronWeb([new Error('503'), IN_BLOCK_SUCCESS]).tronWeb, 'TRC20', TX);

            expect(verdict.result).to.equal('SUCCESS');
        });

        it('gives up once the transaction could no longer be included', async () => {
            const error = await waitForTronExecution(fakeTronWeb([NOT_IN_BLOCK]).tronWeb, 'TRC20', TX, { timeoutMs: 50, intervalMs: 5 }).catch((e) => e);

            expect(error).to.be.instanceOf(TronConfirmationTimeoutError);
            expect(error.txId).to.equal(TX);
        });

        it('maps to tx_failed and tx_not_confirmed with the tx_id, keeping the old 500', () => {
            const failed = toErrorResponse(new TronExecutionFailedError(TX, 'OUT_OF_ENERGY', '', 1));
            const timeout = toErrorResponse(new TronConfirmationTimeoutError(TX, 90000));

            expect(failed).to.deep.include({ status: 500 });
            expect(failed.body).to.deep.include({ code: 'tx_failed' });
            expect(failed.body.details).to.deep.include({ tx_id: TX, result: 'OUT_OF_ENERGY' });
            expect(timeout.body.code).to.equal('tx_not_confirmed');
        });
    });

    describe('TronPayoutService', () => {
        function service(fake: ReturnType<typeof fakeTronWeb>): TronPayoutService {
            const tron = new TronPayoutService('trc20', KEY);
            (tron as any).tronWeb = fake.tronWeb;
            return tron;
        }

        it('answers a TRC20 payout only after it executed, and alerts success once', async () => {
            const fake = fakeTronWeb([NOT_IN_BLOCK, IN_BLOCK_SUCCESS]);

            const txId = await service(fake).sendTransaction(PAYEE, '1.5', TOKEN, 'USDT');

            expect(txId).to.equal(TX);
            expect(fake.calls.transfer).to.deep.equal([[PAYEE, '1500000']]);
            expect(alerts).to.have.length(1);
        });

        it('fails a TRC20 payout that ran out of energy instead of reporting it as paid', async () => {
            const fake = fakeTronWeb([IN_BLOCK_OUT_OF_ENERGY]);

            const error = await service(fake).sendTransaction(PAYEE, '1', TOKEN, 'USDT').catch((e) => e);

            expect(error).to.be.instanceOf(TronExecutionFailedError);
            expect(alerts).to.have.length(1);
            expect(alerts[0]).to.contain('OUT_OF_ENERGY');
        });

        it('with wait_for_receipt false answers at once and settles the journal from the background check', async () => {
            const store = new PayoutStore(null);
            setPayoutStore(store);
            const fake = fakeTronWeb([NOT_IN_BLOCK, NOT_IN_BLOCK, IN_BLOCK_REVERT]);

            const result = await runPayout(
                { scope: 'payout/tron', chain: 'tron', payload: { amount: '1' }, settlesInBackground: true },
                () => service(fake).sendTransaction(PAYEE, '1', TOKEN, 'USDT', undefined, false)
            );
            expect(store.get(result.payoutId)?.status).to.equal('submitted');

            await new Promise<void>((resolve, reject) => {
                const started = Date.now();
                const tick = () => {
                    if (store.get(result.payoutId)?.status === 'failed') return resolve();
                    if (Date.now() - started > 3000) return reject(new Error('not settled'));
                    setTimeout(tick, 10);
                };
                tick();
            });
            expect(store.get(result.payoutId)?.error?.code).to.equal('tx_failed');
        });

        it('rounds digits past the token decimals instead of gluing them onto the integer part', async () => {
            const fake = fakeTronWeb([IN_BLOCK_NATIVE]);

            await service(fake).sendTransaction(PAYEE, '1.1234567', undefined, 'TRX');

            // the old concatenation sent "11234567" sun, ten times the amount
            expect(fake.calls.native).to.deep.equal([[PAYEE, '1123457']]);
        });

        it('converts plain amounts exactly as before', async () => {
            const fake = fakeTronWeb([IN_BLOCK_NATIVE]);
            const tron = service(fake);

            for (const amount of ['1', '1.5', '0.000001', '.5', '100']) {
                await tron.sendTransaction(PAYEE, amount, undefined, 'TRX');
            }

            expect(fake.calls.native.map((c) => c[1])).to.deep.equal(['1000000', '1500000', '1', '500000', '100000000']);
        });
    });

    describe('TronMultiPayoutService', () => {
        async function service(fake: ReturnType<typeof fakeTronWeb>): Promise<TronMultiPayoutService> {
            const tron = new TronMultiPayoutService('trc20', KEY);
            (tron as any).tronWeb = fake.tronWeb;
            (tron as any).contractInstance = await fake.tronWeb.contract().at();
            return tron;
        }

        it('scales token amounts by the token decimals, not always by 6', async () => {
            const fake = fakeTronWeb([IN_BLOCK_SUCCESS], 18);

            await (await service(fake)).multiSend(TOKEN, [{ address: PAYEE, amount: '2' }], 'TKN');

            expect(fake.calls.multiToken).to.deep.equal([[TOKEN, [PAYEE], ['2000000000000000000']]]);
        });

        it('keeps 6-decimal tokens and TRX exactly as before', async () => {
            const usdt = fakeTronWeb([IN_BLOCK_SUCCESS], 6);
            const trx = fakeTronWeb([IN_BLOCK_SUCCESS]);

            await (await service(usdt)).multiSend(TOKEN, [{ address: PAYEE, amount: '1.5' }], 'USDT');
            await (await service(trx)).multiSend(undefined, [{ address: PAYEE, amount: '1.5' }], 'TRX');

            expect(usdt.calls.multiToken[0][2]).to.deep.equal(['1500000']);
            expect(trx.calls.multiTrx[0][1]).to.deep.equal(['1500000']);
        });

        it('fails a multi-send whose contract call reverted', async () => {
            const fake = fakeTronWeb([IN_BLOCK_REVERT]);

            const error = await (await service(fake)).multiSend(undefined, [{ address: PAYEE, amount: '1' }], 'TRX').catch((e) => e);

            expect(error).to.be.instanceOf(TronExecutionFailedError);
        });
    });
});
