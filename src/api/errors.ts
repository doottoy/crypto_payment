/* External dependencies */
import { ZodError } from 'zod';
import { InsufficientFundsError } from 'viem';

/* Internal dependencies */
import { IdempotencyConflictError } from '../utils/idempotency';
import { EvmNonceTakenError, EvmTransactionRevertedError } from '../utils/evm';

/**
 * An error the API answers with a fixed HTTP status and a machine-readable code.
 * Services throw it for failures they can name (bad input, a node verdict), everything else maps in toErrorResponse.
 */
export class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
        readonly details?: unknown
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

/**
 * Litecoin Core (or any bitcoind-family node) answered a JSON-RPC call with an error object.
 * `rpcCode` is the node's own code, e.g. -6 for insufficient funds.
 */
export class CoreRpcError extends Error {
    constructor(
        readonly method: string,
        readonly rpcCode: number | undefined,
        message: string
    ) {
        super(`${method} failed: ${message}${rpcCode === undefined ? '' : ` (code ${rpcCode})`}`);
        this.name = 'CoreRpcError';
    }
}

/**
 * `error` stays a plain string: the bridge (400) and request_id conflict (409) answers already had that shape,
 * `code` and `details` are added next to it.
 */
export interface ErrorBody {
    error: string;
    code: string;
    details?: unknown;
}

const MAX_MESSAGE_LENGTH = 500;

/*
 * HTTP statuses stay the ones the service always answered with, so existing clients see no change:
 * 400 for a request that cannot be read, 409 for a request_id conflict, 500 for anything that failed while
 * processing. `code` is what tells those failures apart.
 */
const PROCESSING_FAILED = 500;

/* Bitcoin Core RPC error codes worth naming (src/rpc/protocol.h) */
const CORE_RPC_CODES: Record<number, string> = {
    [-3]: 'invalid_request', // RPC_TYPE_ERROR
    [-5]: 'invalid_address', // RPC_INVALID_ADDRESS_OR_KEY
    [-6]: 'insufficient_funds', // RPC_WALLET_INSUFFICIENT_FUNDS
    [-8]: 'invalid_request', // RPC_INVALID_PARAMETER
    [-18]: 'wallet_not_found' // RPC_WALLET_NOT_FOUND
};

/**
 * Error text that is safe to hand to a client: viem appends the provider URL (API keys included) and the request
 * body to its messages, so only the first paragraph is kept and URL credentials are masked.
 */
export function sanitizeErrorMessage(raw: string): string {
    const firstParagraph = raw.split(/\n\s*\n/)[0];
    const cleaned = firstParagraph
        .replace(/^(URL|Request body|Raw Call Arguments|Version|Docs|Details|Contract Call):.*$/gm, '')
        .replace(/(\/v[0-9]+\/)[0-9a-fA-F]{20,}/g, '$1***')
        .replace(/([?&](api[-_]?key|key|token)=)[^&\s]+/gi, '$1***')
        .replace(/\s+/g, ' ')
        .trim();

    return cleaned.length > MAX_MESSAGE_LENGTH ? `${cleaned.slice(0, MAX_MESSAGE_LENGTH)}...` : cleaned;
}

function errorChain(err: unknown): unknown[] {
    const chain: unknown[] = [];
    for (let current: any = err; current && chain.length < 10 && !chain.includes(current); current = current.cause) {
        chain.push(current);
    }
    return chain;
}

function messageOf(err: unknown): string {
    const anyErr = err as any;
    return sanitizeErrorMessage(String(anyErr?.shortMessage || anyErr?.message || anyErr || 'Unknown error'));
}

function body(code: string, message: string, details?: unknown): ErrorBody {
    return details === undefined ? { error: message, code } : { error: message, code, details };
}

/**
 * Maps any error thrown while handling a request to the HTTP status and JSON body the client receives.
 * Never includes stack traces or request values (private keys travel in request bodies).
 */
export function toErrorResponse(err: unknown): { status: number; body: ErrorBody } {
    if (err instanceof ApiError) {
        return { status: err.status, body: body(err.code, err.message, err.details) };
    }

    if (err instanceof ZodError) {
        const details = err.issues.map((issue) => ({
            path: issue.path.map(String).join('.'),
            message: issue.message
        }));
        const first = details[0];
        const message = first ? `${first.path || 'body'}: ${first.message}` : 'Invalid request';
        return { status: 400, body: body('invalid_request', message, details) };
    }

    if (err instanceof IdempotencyConflictError) {
        return { status: 409, body: body('idempotency_conflict', err.message) };
    }

    const anyErr = err as any;

    // express.json() parse failures
    if (anyErr?.type === 'entity.parse.failed') {
        return { status: 400, body: body('invalid_json', 'Request body is not valid JSON') };
    }
    if (anyErr?.type === 'entity.too.large') {
        return { status: 413, body: body('payload_too_large', 'Request body is too large') };
    }

    if (err instanceof EvmTransactionRevertedError) {
        return {
            status: PROCESSING_FAILED,
            body: body('tx_reverted', messageOf(err), { tx_id: err.txHash, block_number: err.blockNumber, gas_used: err.gasUsed })
        };
    }

    if (err instanceof EvmNonceTakenError) {
        return {
            status: PROCESSING_FAILED,
            body: body('nonce_taken', messageOf(err), { tx_id: err.txHash, foreign_tx_id: err.foreignTxHash, nonce: err.nonce })
        };
    }

    if (err instanceof CoreRpcError) {
        const code = (err.rpcCode === undefined ? undefined : CORE_RPC_CODES[err.rpcCode]) ?? 'node_error';
        return {
            status: PROCESSING_FAILED,
            body: body(code, messageOf(err), err.rpcCode === undefined ? undefined : { rpc_code: err.rpcCode })
        };
    }

    if (errorChain(err).some((e) => e instanceof InsufficientFundsError)) {
        return { status: PROCESSING_FAILED, body: body('insufficient_funds', messageOf(err)) };
    }

    const message = messageOf(err);
    if (/all rpc providers failed/i.test(message)) {
        return { status: PROCESSING_FAILED, body: body('rpc_unavailable', message) };
    }

    return { status: PROCESSING_FAILED, body: body('internal_error', message) };
}
