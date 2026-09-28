/* External dependencies */
import { arbitrumSepolia, baseSepolia, bscTestnet, polygonAmoy, sepolia, type Chain } from 'viem/chains';
import {
    TimeoutError,
    RpcRequestError,
    HttpRequestError,
    FeeCapTooLowError,
    NonceTooHighError,
    SocketClosedError,
    FeeCapTooHighError,
    NonceMaxValueError,
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
    const p = payway.toLowerCase();

    if ((Const.ETH_PAYWAY as readonly string[]).includes(p)) return sepolia;
    if ((Const.BSC_PAYWAY as readonly string[]).includes(p)) return bscTestnet;
    if ((Const.ARBITRUM_PAYWAY as readonly string[]).includes(p)) return arbitrumSepolia;
    if ((Const.BASE_PAYWAY as readonly string[]).includes(p)) return baseSepolia;
    if ((Const.POLYGON_PAYWAY as readonly string[]).includes(p)) return polygonAmoy;

    throw new Error(`Unsupported payway for chain mapping: ${payway}`);
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