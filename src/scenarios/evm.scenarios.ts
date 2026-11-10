/* External dependencies */
import { encodeFunctionData, parseUnits, type Abi, type Address, type Hex } from 'viem';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { ApiError } from '../api/errors';
import { EvmTransactionRevertedError } from '../utils/evm';
import { PayoutService } from '../services/payout.service';
import { EvmContractService } from '../services/evm.contract.service';
import { deployToken } from '../services/token.service';

const ERC20_ABI = [
    { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
    { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
    { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
    { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
    { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }
] as const satisfies Abi;

export interface ScenarioResult {
    scenario: string;
    txId: Hex | string;
    /** what a deposit system has to do with this transaction */
    expected: string;
    details: Record<string, unknown>;
}

/**
 * An ERC20 transfer that is mined but reverts: the call data names the payee and the amount, yet no tokens move.
 * A deposit system that credits by decoding transaction input instead of reading the receipt and its Transfer logs
 * credits it. The transfer asks for more than the sender holds, with a gas limit taken from a transfer that would
 * succeed, so it always reaches a block and always reverts.
 */
export async function revertedErc20Transfer(input: {
    payway: string; privateKey: string; payee: Address; contract: Address; amount: string; requestId?: string;
}): Promise<ScenarioResult> {
    const service = new EvmContractService(input.payway, input.privateKey);
    await service.init();

    const [decimals, balance] = await Promise.all([
        service.read<number>(input.contract, ERC20_ABI, 'decimals'),
        service.read<bigint>(input.contract, ERC20_ABI, 'balanceOf', [service.senderAddress])
    ]);
    const overBalance = balance + parseUnits(input.amount, Number(decimals));
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [input.payee, overBalance] });
    // A zero transfer runs the same code path short of the balance check, so its estimate covers the reverting call
    const gas = await service.estimate(input.contract, encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [input.payee, 0n] }));

    try {
        const { txHash } = await service.sendAndConfirm({ to: input.contract, data, gas: (gas * 150n) / 100n, label: 'SCENARIO_REVERTED_TRANSFER', requestId: input.requestId });
        throw new ApiError(422, 'scenario_not_reproduced', `Transfer ${txHash} succeeded: the token did not revert a transfer above the sender balance`, { tx_id: txHash });
    } catch (error) {
        if (!(error instanceof EvmTransactionRevertedError)) throw error;
        logger.info(input.payway.toUpperCase(), `🧪[SCENARIO][REVERTED_TRANSFER][HASH:${error.txHash}]`);
        return {
            scenario: 'evm/reverted_transfer',
            txId: error.txHash,
            expected: 'not credited: the transaction reverted, no Transfer event, no balance change',
            details: { contract: input.contract, payee: input.payee, amount_in_call_data: overBalance.toString(), decimals: Number(decimals), block_number: error.blockNumber }
        };
    }
}

/**
 * A token that copies the name, symbol and decimals of a real one, sent to the payee with an ordinary transfer.
 * A deposit system that matches tokens by symbol instead of contract address credits it. Pass `fakeContract` from an
 * earlier answer to reuse the copy instead of deploying another one.
 */
export async function lookalikeTokenTransfer(input: {
    payway: string; privateKey: string; payee: Address; original: Address; amount: string; fakeContract?: Address; requestId?: string;
}): Promise<ScenarioResult> {
    const reader = new EvmContractService(input.payway, input.privateKey);
    await reader.init();
    const [name, symbol, decimals] = await Promise.all([
        reader.read<string>(input.original, ERC20_ABI, 'name'),
        reader.read<string>(input.original, ERC20_ABI, 'symbol'),
        reader.read<number>(input.original, ERC20_ABI, 'decimals')
    ]);

    let fakeContract = input.fakeContract;
    let deployTx: string | undefined;
    if (!fakeContract) {
        // Enough supply for many sends, minted to the deployer, so the payout below is a plain transfer from it
        const deployed = await deployToken({
            payway: input.payway, privateKey: input.privateKey, preset: 'standard', name, symbol, decimals: Number(decimals),
            initialSupply: '1000000000', requestId: input.requestId
        });
        fakeContract = deployed.contractAddress;
        deployTx = deployed.txId;
    }

    const payout = new PayoutService(input.payway, input.privateKey);
    await payout.init();
    const txId = await payout.sendTransaction(input.payee, input.amount, fakeContract, symbol, true, input.requestId);
    logger.info(input.payway.toUpperCase(), `🧪[SCENARIO][LOOKALIKE_TOKEN][${symbol}][FAKE:${fakeContract}][HASH:${txId}]`);

    return {
        scenario: 'evm/lookalike_token',
        txId,
        expected: 'not credited: same name, symbol and decimals as the real token, different contract address',
        details: { original_contract: input.original, fake_contract: fakeContract, deploy_tx_id: deployTx ?? null, name, symbol, decimals: Number(decimals), amount: input.amount }
    };
}

/**
 * A deposit that is broadcast and then cancelled: a native transfer to the payee replaced on the same nonce by a
 * 0-value transfer back to the sender. A deposit system that credits transactions it saw in the mempool credits money
 * that never arrived. On fast chains the original can be mined before the cancel arrives; the answer says which.
 */
export async function replacedNativeTransfer(input: {
    payway: string; privateKey: string; payee: Address; amount: string; requestId?: string;
}): Promise<ScenarioResult> {
    const service = new EvmContractService(input.payway, input.privateKey);
    await service.init();
    const result = await service.sendReplacedTransfer({ payee: input.payee, value: parseUnits(input.amount, 18), requestId: input.requestId });
    logger.info(input.payway.toUpperCase(), `🧪[SCENARIO][REPLACED_TRANSFER][${result.outcome}][MINED:${result.minedTxId}]`);

    return {
        scenario: 'evm/replaced_transfer',
        txId: result.originalTxId,
        expected: result.outcome === 'replaced'
            ? 'not credited: the transfer to the payee was replaced by a cancel and never mined'
            : 'credited once: the chain mined the original transfer before the cancel arrived',
        details: {
            outcome: result.outcome,
            original_tx_id: result.originalTxId,
            replacement_tx_id: result.replacementTxId,
            mined_tx_id: result.minedTxId,
            payee: input.payee,
            amount: input.amount
        }
    };
}

export type { Hex };
