import 'mocha';
import bs58 from 'bs58';
import { expect } from 'chai';
import { Keypair } from '@solana/web3.js';
import { InsufficientFundsError, BaseError } from 'viem';

import { CoreRpcError, ApiError, sanitizeErrorMessage, toErrorResponse } from '../../api/errors';
import { amount, toPlainDecimal, solanaPayoutSchema, evmPayoutSchema } from '../../api/schemas';
import { IdempotencyConflictError } from '../../utils/idempotency';

describe('toErrorResponse', () => {
    it('keeps ApiError status, code and details', () => {
        const res = toErrorResponse(new ApiError(422, 'custom_code', 'Custom message', { a: 1 }));

        expect(res).to.deep.equal({ status: 422, body: { error: 'Custom message', code: 'custom_code', details: { a: 1 } } });
    });

    it('answers request_id conflicts with 409 and the message as a string', () => {
        const res = toErrorResponse(new IdempotencyConflictError('payout/evm', 'abc'));

        expect(res.status).to.equal(409);
        expect(res.body.code).to.equal('idempotency_conflict');
        expect(res.body.error).to.be.a('string');
    });

    it('finds insufficient funds anywhere in the cause chain', () => {
        const err = new Error('send failed', { cause: new InsufficientFundsError() });

        expect(toErrorResponse(err).status).to.equal(400);
        expect(toErrorResponse(err).body.code).to.equal('insufficient_funds');
    });

    it('maps exhausted providers to 502 rpc_unavailable', () => {
        const res = toErrorResponse(new Error('All RPC providers failed for payway = eth: timeout'));

        expect(res).to.deep.include({ status: 502 });
        expect(res.body.code).to.equal('rpc_unavailable');
    });

    it('maps node error codes the caller can fix to 400', () => {
        expect(toErrorResponse(new CoreRpcError('sendtoaddress', -6, 'Insufficient funds')).body.code).to.equal('insufficient_funds');
        expect(toErrorResponse(new CoreRpcError('sendtoaddress', -5, 'Invalid address')).status).to.equal(400);
        expect(toErrorResponse(new CoreRpcError('sendtoaddress', -1, 'boom')).status).to.equal(502);
    });

    it('hides internals of unknown errors behind internal_error without a stack', () => {
        const res = toErrorResponse(new TypeError('Cannot read properties of undefined'));

        expect(res.status).to.equal(500);
        expect(res.body.code).to.equal('internal_error');
        expect(JSON.stringify(res.body)).to.not.contain('at ');
    });

    it('prefers the short message of viem errors', () => {
        const err = new BaseError('Short and safe', { details: 'node said no' });

        expect(toErrorResponse(err).body.error).to.equal('Short and safe');
    });
});

describe('sanitizeErrorMessage', () => {
    it('drops viem detail lines and masks provider keys', () => {
        const raw = [
            'HTTP request failed. Status: 429 at https://sepolia.infura.io/v3/7a4583d0b3014189bbff7f24582fc5ea',
            'URL: https://sepolia.infura.io/v3/7a4583d0b3014189bbff7f24582fc5ea',
            'Request body: {"method":"eth_sendRawTransaction"}'
        ].join('\n');

        const clean = sanitizeErrorMessage(raw);

        expect(clean).to.not.contain('7a4583d0b3014189bbff7f24582fc5ea');
        expect(clean).to.not.contain('Request body');
        expect(clean).to.contain('/v3/***');
    });
});

describe('request schemas', () => {
    it('turns numeric amounts into plain decimals', () => {
        expect(toPlainDecimal(0.0000001)).to.equal('0.0000001');
        expect(amount.parse(1.5)).to.equal('1.5');
        expect(amount.parse(' 2 ')).to.equal('2');
        expect(amount.safeParse('-1').success).to.equal(false);
        expect(amount.safeParse('1e-7').success).to.equal(false);
    });

    it('treats null and blank optional fields as not provided', () => {
        const parsed = solanaPayoutSchema.parse({
            private_key: bs58.encode(Keypair.generate().secretKey),
            amount: '0.1',
            payee_address: '11111111111111111111111111111111',
            token_mint: null,
            is_token_2022: 'false'
        });

        expect(parsed.token_mint).to.equal(undefined);
        expect(parsed.is_token_2022).to.equal(false);
    });

    it('lowercases the payway so ETH works like eth', () => {
        const parsed = evmPayoutSchema.parse({
            payway: 'ETH',
            payee_address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
            amount: '1',
            private_key: '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
            contract: ''
        });

        expect(parsed.payway).to.equal('eth');
        expect(parsed.contract).to.equal(undefined);
    });
});
