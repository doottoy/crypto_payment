import 'mocha';
import bs58 from 'bs58';
import { expect } from 'chai';
import { Keypair } from '@solana/web3.js';

import { TronPayoutService } from '../../services/tron.payout.service';
import {
    flagOr,
    parseData,
    evmAmount,
    ltcAmount,
    tronAmount,
    solanaAmount,
    expandExponent,
    toPlainDecimal,
    bridgeSchema,
    ltcPayoutSchema,
    evmPayoutSchema,
    tronPayoutSchema,
    ltcMultiSendSchema,
    evmMultiSendSchema,
    evmBatchSendSchema,
    solanaPayoutSchema,
    tronMultiSendSchema,
    solanaMultiSendSchema
} from '../../api/schemas';

/*
 * Every request shape the service accepted before validation existed must still be accepted with the same meaning.
 * The payloads below are the README examples (placeholders swapped for real-looking values) and the loose inputs the
 * handlers used to tolerate.
 */

const EVM_KEY = '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const EVM_A = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const EVM_B = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const SOL_KEY = bs58.encode(Keypair.generate().secretKey);
const SOL_A = Keypair.generate().publicKey.toBase58();
const SOL_MINT = Keypair.generate().publicKey.toBase58();
const TRON_A = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';
const TRON_B = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

describe('backward compatibility of request shapes', () => {
    describe('README examples are accepted unchanged', () => {
        it('EVM single, multi-send and batch-send', () => {
            expect(() => parseData(evmPayoutSchema, { data: {
                payway: 'eth', payee_address: EVM_A, amount: '0.1', contract: EVM_B, currency: 'ETH',
                private_key: EVM_KEY, wait_for_receipt: true, request_id: 'uuid-or-stable-client-id'
            } })).to.not.throw();
            expect(() => parseData(evmMultiSendSchema, { data: {
                payway: 'eth', recipients: [{ address: EVM_A, amount: '0.05' }, { address: EVM_B, amount: '0.05' }],
                currency: 'ETH', private_key: EVM_KEY, multi_send_contract: EVM_B, wait_for_receipt: true, request_id: 'r'
            } })).to.not.throw();
            expect(() => parseData(evmBatchSendSchema, { data: {
                payway: 'eth', private_key: EVM_KEY, currency: 'ETH', batch_send_contract: EVM_B,
                native_transfers: [{ to: EVM_A, amount: '0.015' }], token_transfers: [{ token_address: EVM_B, to: EVM_A, amount: '1' }]
            } })).to.not.throw();
        });

        it('Litecoin single and multi-send', () => {
            expect(() => parseData(ltcPayoutSchema, { data: {
                method: 'sendtoaddress', payee_address: 'tltc1qexample', amount: '1.0', payway: 'LTC', currency: 'LTC'
            } })).to.not.throw();
            expect(() => parseData(ltcMultiSendSchema, { data: {
                method: 'sendmany', payway: 'LTC', currency: 'LTC',
                recipients: [{ address: 'tltc1qa', amount: '0.5' }, { address: 'tltc1qb', amount: '0.5' }],
                comment: 'Payment for services', minconf: 1, account: 'wallet_label'
            } })).to.not.throw();
        });

        it('Solana single (with token_mint null) and multi-send', () => {
            const single = parseData(solanaPayoutSchema, { data: {
                payway: 'sol', currency: 'SOL', amount: '0.1', payee_address: SOL_A, private_key: SOL_KEY, token_mint: null, is_token_2022: false
            } });
            expect(single.token_mint).to.equal(undefined);
            expect(() => parseData(solanaMultiSendSchema, { data: {
                private_key: SOL_KEY, currency: 'SOL', token_mint: null, recipients: [{ address: SOL_A, amount: '0.05' }]
            } })).to.not.throw();
        });

        it('Tron single in both shapes and multi-send', () => {
            const current = TronPayoutService.normalizeTronPayload({ data: {
                payway: 'tron', payee_address: TRON_A, amount: '0.1', contract: TRON_B, currency: 'TRX', private_key: EVM_KEY
            } });
            const legacy = TronPayoutService.normalizeTronPayload({
                from: TRON_B, private_key: EVM_KEY, to: TRON_A, amount: '1000000', currency: 'USDT', payway: 'trc20', contract_id: TRON_B
            });
            expect(tronPayoutSchema.parse(current).isLegacy).to.equal(false);
            expect(tronPayoutSchema.parse(legacy)).to.deep.include({ isLegacy: true, payee_address: TRON_A, contract: TRON_B, amount: '1000000' });
            expect(() => parseData(tronMultiSendSchema, { data: {
                payway: 'tron', recipients: [{ address: TRON_A, amount: '0.05' }], private_key: EVM_KEY, currency: 'TRX',
                multi_send_contract: TRON_B, token_contract: TRON_B
            } })).to.not.throw();
        });

        it('Bridge with and without payee_address', () => {
            expect(() => parseData(bridgeSchema, { data: { destination: 'base', amount: '0.01', payee_address: EVM_A, private_key: EVM_KEY, wait_for_receipt: true, request_id: 'r' } })).to.not.throw();
            expect(() => parseData(bridgeSchema, { data: { destination: 'arbitrum', amount: '0.01', private_key: EVM_KEY } })).to.not.throw();
        });
    });

    describe('loose inputs keep their old meaning', () => {
        it('wait_for_receipt and is_token_2022 keep JavaScript truthiness', () => {
            expect(flagOr(undefined, true)).to.equal(true);
            expect(flagOr(null, true)).to.equal(false);
            expect(flagOr(false, true)).to.equal(false);
            expect(flagOr('false', true)).to.equal(true);
            expect(flagOr(0, true)).to.equal(false);
            expect(flagOr(undefined, false)).to.equal(false);
            expect(flagOr('false', false)).to.equal(true);
        });

        it('request_id and currency may be numbers', () => {
            const parsed = parseData(ltcPayoutSchema, { data: { payee_address: 'tltc1q', amount: 1, request_id: 12345, currency: 7 } });

            expect(parsed.request_id).to.equal('12345');
            expect(parsed.currency).to.equal('7');
        });

        it('EVM amounts take the forms parseUnits took, and numbers', () => {
            expect(evmAmount.parse('.5')).to.equal('.5');
            expect(evmAmount.parse('5.')).to.equal('5.');
            expect(evmAmount.parse('')).to.equal('0');
            expect(evmAmount.parse(0.25)).to.equal('0.25');
            expect(evmAmount.parse('1e-7')).to.equal('0.0000001');
            expect(evmAmount.safeParse('-1').success).to.equal(false);
            expect(evmAmount.safeParse('abc').success).to.equal(false);
        });

        it('a blank contract still means a native transfer', () => {
            const parsed = parseData(evmPayoutSchema, { data: { payway: 'ETH', payee_address: EVM_A, amount: '1', private_key: `0x${EVM_KEY}`, contract: '' } });

            expect(parsed.contract).to.equal(undefined);
            expect(parsed.payway).to.equal('eth');
        });

        it('Solana amounts pass through whatever parseFloat read', () => {
            expect(solanaAmount.parse('0.5 SOL')).to.equal('0.5 SOL');
            expect(solanaAmount.parse('1e-9')).to.equal('1e-9');
            expect(solanaAmount.parse(0.1)).to.equal('0.1');
            expect(solanaAmount.safeParse('-0.1').success).to.equal(false);
            expect(solanaAmount.safeParse('abc').success).to.equal(false);
        });

        it('Litecoin multi-send amounts are left to the service as before, in both recipient shapes', () => {
            expect(() => parseData(ltcMultiSendSchema, { data: { recipients: [{ address: 'a', amount: '1e-3' }] } })).to.not.throw();
            expect(() => parseData(ltcMultiSendSchema, { data: { recipients: { tltc1qa: 0.5, tltc1qb: '0.25' } } })).to.not.throw();
        });

        it('Litecoin single amounts the node took are still taken', () => {
            expect(ltcAmount.parse(0.5)).to.equal('0.5');
            expect(ltcAmount.parse('1e-3')).to.equal('0.001');
            expect(ltcAmount.parse('0.12345678')).to.equal('0.12345678');
            expect(ltcAmount.safeParse('0.123456789').success).to.equal(false);
        });

        it('Tron legacy base-unit integers and plain decimals pass', () => {
            expect(tronAmount.parse('1000000')).to.equal('1000000');
            expect(tronAmount.parse(1.5)).to.equal('1.5');
        });

        it('empty multi-send and batch lists are not rejected up front', () => {
            expect(() => parseData(evmMultiSendSchema, { data: { payway: 'eth', recipients: [], private_key: EVM_KEY, multi_send_contract: EVM_B } })).to.not.throw();
            expect(() => parseData(evmBatchSendSchema, { data: { payway: 'eth', private_key: EVM_KEY, batch_send_contract: EVM_B } })).to.not.throw();
        });

        it('unknown extra fields are ignored', () => {
            expect(() => parseData(evmPayoutSchema, { data: { payway: 'eth', payee_address: EVM_A, amount: '1', private_key: EVM_KEY, note: 'x', from: EVM_B } })).to.not.throw();
        });
    });

    describe('number helpers', () => {
        it('expands exponent notation on the digits', () => {
            expect(expandExponent('1e-7')).to.equal('0.0000001');
            expect(expandExponent('1.5E+3')).to.equal('1500');
            expect(expandExponent('2.5e-1')).to.equal('0.25');
            expect(expandExponent('12e-1')).to.equal('1.2');
            expect(expandExponent('0001e2')).to.equal('100');
            expect(expandExponent('1.25')).to.equal('1.25');
            expect(toPlainDecimal(1e21)).to.equal('1000000000000000000000');
            expect(toPlainDecimal(0.1)).to.equal('0.1');
        });
    });
});
