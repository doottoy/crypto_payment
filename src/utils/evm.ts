/* External dependencies */
import type { Chain } from 'viem/chains';
import {
    type Hex,
    keccak256,
    TimeoutError,
    RpcRequestError,
    HttpRequestError,
    parseTransaction,
    FeeCapTooLowError,
    NonceTooHighError,
    SocketClosedError,
    FeeCapTooHighError,
    NonceMaxValueError,
    type TransactionReceipt,
    InvalidAddressError,
    TipAboveFeeCapError,
    WebSocketRequestError,
    ExecutionRevertedError,
    InsufficientFundsError,
    IntrinsicGasTooLowError,
    IntrinsicGasTooHighError,
    ContractFunctionRevertedError,
    ContractFunctionZeroDataError,
    TransactionTypeNotSupportedError
} from 'viem';

/* Constants */
import { Const } from '../constants/const';
import { findEvmNetwork } from '../networks/evm-networks';

/* A node's verdict on the transaction itself - every provider answers the same, so failing over only wastes time */
const EVM_TX_REJECTION_ERRORS = [
    ExecutionRevertedError,
    ContractFunctionRevertedError,
    ContractFunctionZeroDataError,
    InsufficientFundsError,
    IntrinsicGasTooHighError,
    IntrinsicGasTooLowError,
    FeeCapTooHighError,
    FeeCapTooLowError,
    TipAboveFeeCapError,
    NonceTooHighError,
    NonceMaxValueError,
    TransactionTypeNotSupportedError,
    InvalidAddressError
];

/* The request itself failed at the provider: HTTP error status, JSON-RPC error reply, timeout or dropped socket */
const EVM_PROVIDER_REQUEST_ERRORS = [
    HttpRequestError,
    RpcRequestError,
    TimeoutError,
    SocketClosedError,
    WebSocketRequestError
];

/**
 * Resolves viem chain config by logical payway name.
 */
export function getChainForPayway(payway: string): Chain {
    const network = findEvmNetwork(payway);
    if (!network) {
        throw new Error(`Unsupported payway for chain mapping: ${payway}`);
    }
    return network.chain;
}

export function getEvmErrorMessage(err: any): string {
    return (
        err?.message ||
        err?.data?.message ||
        err?.toString?.() ||
        ''
    ).toLowerCase();
}

/**
 * Determines whether an error is network-related (DNS, timeout, connection).
 */
export function isEvmNetworkError(err: any): boolean {
    const msg = getEvmErrorMessage(err);

    return (Const.NETWORK_ERROR_PATTERNS as readonly string[]).some((sub) => msg.includes(sub));
}

function getErrorChain(err: any): any[] {
    const chain: any[] = [];
    for (let current = err; current && chain.length < 10 && !chain.includes(current); current = current.cause) {
        chain.push(current);
    }
    return chain;
}

/**
 * Determines whether the RPC provider failed or refused the request itself rather than rejecting the transaction.
 * A provider that is up but refuses a method answers HTTP 200 with a JSON-RPC error whose wording no pattern list
 * can foresee - e.g. drpc.org on Base Sepolia: "no available upstreams ... No label `flashblocks`".
 */
export function isEvmProviderError(err: any): boolean {
    const chain = getErrorChain(err);

    if (chain.some((e) => EVM_TX_REJECTION_ERRORS.some((ErrorClass) => e instanceof ErrorClass))) {
        return false;
    }

    return chain.some((e) => EVM_PROVIDER_REQUEST_ERRORS.some((ErrorClass) => e instanceof ErrorClass));
}

/**
 * Detects provider replies that indicate the signed transaction is already in the mempool.
 */
export function isEvmAlreadyKnownError(err: any): boolean {
    const msg = getEvmErrorMessage(err);

    return [
        'already known',
        'already imported',
        'known transaction',
        'tx already exists'
    ].some((sub) => msg.includes(sub));
}

/**
 * A mined transaction can still have failed (status = reverted, e.g. out of gas): the nonce and the gas are spent but
 * no funds moved, so it must never be reported as a successful payout. The verdict is final - neither another provider
 * nor a re-signed replacement (its nonce is already spent) can change it.
 * Fields are strings: the notifier serialises EVM errors with JSON.stringify, which throws on bigint.
 */
export class EvmTransactionRevertedError extends Error {
    readonly shortMessage = 'Transaction was mined but reverted - funds were not transferred';
    readonly txHash: Hex;
    readonly blockNumber: string;
    readonly gasUsed: string;
    readonly gasLimit?: string;

    constructor(receipt: TransactionReceipt, gasLimit?: bigint) {
        const gas = gasLimit === undefined ? `${receipt.gasUsed}` : `${receipt.gasUsed} of ${gasLimit}`;
        super(`Transaction ${receipt.transactionHash} reverted on-chain in block ${receipt.blockNumber} (gas used ${gas}) - funds were not transferred`);
        this.name = 'EvmTransactionRevertedError';
        this.txHash = receipt.transactionHash;
        this.blockNumber = receipt.blockNumber.toString();
        this.gasUsed = receipt.gasUsed.toString();
        this.gasLimit = gasLimit?.toString();
    }
}

/**
 * Throws EvmTransactionRevertedError when the receipt reports a reverted transaction; no receipt (not waited for) passes.
 * The signed `rawTx` only adds its gas limit to the error, so an out-of-gas revert (gas used = limit) is visible in the alert.
 */
export function assertEvmReceiptSuccess(receipt: TransactionReceipt | undefined, rawTx?: Hex): void {
    if (receipt?.status !== 'reverted') return;

    throw new EvmTransactionRevertedError(receipt, rawTx ? parseTransaction(rawTx).gas : undefined);
}

/**
 * Another transaction, not signed for this request, was mined with the sender nonce of this one, so this one can never
 * be mined and its payout did not happen. Re-signing on a fresh nonce cannot pay twice.
 * Fields are strings and numbers: the notifier serialises EVM errors with JSON.stringify, which throws on bigint.
 */
export class EvmNonceTakenError extends Error {
    readonly shortMessage = 'The nonce was used by a transaction this request did not sign - funds were not transferred';
    readonly txHash: Hex;
    readonly foreignTxHash: Hex;
    readonly nonce: number;

    constructor(txHash: Hex, foreignTxHash: Hex, nonce: number) {
        super(`Nonce ${nonce} was used by transaction ${foreignTxHash}, which this request did not sign: transaction ${txHash} can never be mined, funds were not transferred`);
        this.name = 'EvmNonceTakenError';
        this.txHash = txHash;
        this.foreignTxHash = foreignTxHash;
        this.nonce = nonce;
    }
}

/**
 * Waiting by hash resolves with the receipt of whichever transaction took the sender nonce (viem replacement detection),
 * so a receipt counts only when it is of the signed `rawTx` or of another hash signed for the same request (a fee bump).
 * Any other receipt throws EvmNonceTakenError.
 */
export function assertOwnReceipt(receipt: TransactionReceipt, rawTx: Hex, ownHashes: ReadonlySet<Hex> = new Set()): void {
    const minedHash = receipt.transactionHash.toLowerCase() as Hex;
    const txHash = keccak256(rawTx);
    if (minedHash === txHash || ownHashes.has(minedHash)) return;

    throw new EvmNonceTakenError(txHash, receipt.transactionHash, parseTransaction(rawTx).nonce ?? 0);
}