/* External dependencies */
import { parseUnits } from 'viem';
import { TronWeb } from 'tronweb';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { ApiError } from '../api/errors';
import { sendTronTransactionVerified, TronExecutionFailedError, waitForTronExecution } from '../utils/tron-broadcast';

/* Constants */
import { Const } from '../constants/const';

import type { ScenarioResult } from './evm.scenarios';

/** 1 TRX: far below what a TRC20 transfer burns without staked energy (several TRX on Nile) */
export const DEFAULT_SCENARIO_FEE_LIMIT_SUN = 1000000;

/**
 * A TRC20 transfer that is included in a block but runs out of energy: the fee is burnt, no tokens move.
 * A deposit system that credits on the transfer call without checking receipt.result credits it.
 * With enough staked energy the transfer would just succeed; that is answered as scenario_not_reproduced.
 */
export async function failedTrc20Transfer(
    input: { payway: string; privateKey: string; payee: string; contract: string; amount: string; feeLimitSun?: number; requestId?: string },
    tronWeb: any = new TronWeb({ fullHost: Const.TRON_NILE, privateKey: input.privateKey })
): Promise<ScenarioResult> {
    const network = input.payway.toUpperCase();
    const feeLimit = input.feeLimitSun ?? DEFAULT_SCENARIO_FEE_LIMIT_SUN;
    const token = await tronWeb.contract().at(input.contract);
    const decimals = Number((await token.decimals().call()).toString());
    const amount = parseUnits(input.amount, decimals).toString();

    const txId = await sendTronTransactionVerified(tronWeb, network, () => token.transfer(input.payee, amount).send({ feeLimit }));

    try {
        await waitForTronExecution(tronWeb, network, txId);
    } catch (error) {
        if (!(error instanceof TronExecutionFailedError)) throw error;
        logger.info(network, `🧪[SCENARIO][FAILED_TRC20][${error.result}][HASH:${txId}]`);
        return {
            scenario: 'tron/failed_trc20',
            txId,
            expected: 'not credited: the transfer is in a block but its execution failed, no tokens moved',
            details: { contract: input.contract, payee: input.payee, amount: input.amount, fee_limit_sun: feeLimit, result: error.result, reason: error.reason, block_number: error.blockNumber ?? null }
        };
    }

    throw new ApiError(422, 'scenario_not_reproduced', `Transfer ${txId} executed successfully: the sender has enough staked energy for it. Use a sender without staked energy or a lower fee_limit_sun.`, { tx_id: txId });
}
