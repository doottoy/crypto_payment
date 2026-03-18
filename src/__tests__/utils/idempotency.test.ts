import 'mocha';
import { expect } from 'chai';

import { IdempotencyConflictError, RequestIdRegistry } from '../../utils/idempotency';

describe('RequestIdRegistry', () => {
    it('returns the same in-flight result for the same request_id and payload', async () => {
        const registry = new RequestIdRegistry();
        let executions = 0;

        const handler = async () => {
            executions += 1;
            await new Promise((resolve) => setTimeout(resolve, 25));
            return '0xtxhash';
        };

        const [first, second] = await Promise.all([
            registry.run('payout/evm', 'req-1', { amount: '1' }, handler),
            registry.run('payout/evm', 'req-1', { amount: '1' }, handler)
        ]);

        expect(first).to.equal('0xtxhash');
        expect(second).to.equal('0xtxhash');
        expect(executions).to.equal(1);
    });

    it('throws a conflict when the same request_id is reused with another payload', async () => {
        const registry = new RequestIdRegistry();

        await registry.run('payout/evm', 'req-2', { amount: '1' }, async () => '0x1');

        let caughtError: unknown;

        try {
            await registry.run('payout/evm', 'req-2', { amount: '2' }, async () => '0x2');
        } catch (error) {
            caughtError = error;
        }

        expect(caughtError).to.be.instanceOf(IdempotencyConflictError);
    });

    it('allows retry after a failed attempt', async () => {
        const registry = new RequestIdRegistry();
        let attempts = 0;

        let caughtError: unknown;

        try {
            await registry.run('payout/evm', 'req-3', { amount: '1' }, async () => {
                attempts += 1;
                throw new Error('boom');
            });
        } catch (error) {
            caughtError = error;
        }

        expect(caughtError).to.be.instanceOf(Error);
        expect((caughtError as Error).message).to.equal('boom');

        const result = await registry.run('payout/evm', 'req-3', { amount: '1' }, async () => {
            attempts += 1;
            return '0xsuccess';
        });

        expect(result).to.equal('0xsuccess');
        expect(attempts).to.equal(2);
    });
});
