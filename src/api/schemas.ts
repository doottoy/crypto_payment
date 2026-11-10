/* External dependencies */
import { z } from 'zod';
import bs58 from 'bs58';
import { isAddress } from 'viem';
import { TronWeb } from 'tronweb';
import { PublicKey } from '@solana/web3.js';

/* Internal dependencies */
import { getChainForPayway } from '../utils/evm';
import { getEvmRpcUrlsForPayway } from '../utils/modules';

/* Constants */
import { Const } from '../constants/const';

/*
 * Request schemas. Rule: a schema only rejects input that already failed before it existed (one step later, often
 * as a hung request or a 500). Anything the services accepted keeps working with the same meaning: unknown fields are
 * ignored, null / '' mean "not provided", flags keep JavaScript truthiness, amounts are checked per chain exactly as
 * loosely as that chain's code parsed them.
 */

const EVM_PAYWAYS: readonly string[] = [
    ...Const.ETH_PAYWAY,
    ...Const.BSC_PAYWAY,
    ...Const.ARBITRUM_PAYWAY,
    ...Const.BASE_PAYWAY,
    ...Const.POLYGON_PAYWAY
];

const PLAIN_DECIMAL = /^\d*\.?\d*$/;

/**
 * "1e-7" / "1.5E+3" to a plain decimal, moving the point on the digits (no float rounding).
 * Anything that is not exponent notation comes back unchanged.
 */
export function expandExponent(value: string): string {
    const match = value.match(/^(\d*)(?:\.(\d*))?[eE]([+-]?\d+)$/);
    if (!match || (!match[1] && !match[2])) return value;

    const intDigits = match[1] ?? '';
    const digits = intDigits + (match[2] ?? '');
    const point = intDigits.length + parseInt(match[3], 10);

    let plain: string;
    if (point <= 0) {
        plain = `0.${'0'.repeat(-point)}${digits}`;
    } else if (point >= digits.length) {
        plain = digits + '0'.repeat(point - digits.length);
    } else {
        plain = `${digits.slice(0, point)}.${digits.slice(point)}`;
    }
    return plain.replace(/^0+(?=\d)/, '');
}

/** A JSON number or numeric string as a plain decimal string: String(1e-7) is "1e-7", which no parser here accepts */
export function toPlainDecimal(value: string | number): string {
    return expandExponent(typeof value === 'number' ? String(value) : value.trim());
}

function fractionDigits(value: string): number {
    return (value.split('.')[1] ?? '').replace(/0+$/, '').length;
}

const numeric = z.union([z.string(), z.number()]);
const isPlainDecimal = (v: string) => PLAIN_DECIMAL.test(v) && /\d/.test(v);
const AMOUNT_MESSAGE = 'must be a non-negative decimal number such as "0.1"';

/** EVM: the forms viem parseUnits took ("1", "1.5", ".5", "5."); a blank amount meant 0 there and still does */
export const evmAmount = numeric
    .transform((v) => {
        const plain = toPlainDecimal(v);
        return plain === '' ? '0' : plain;
    })
    .refine(isPlainDecimal, AMOUNT_MESSAGE);

/** Tron: base units are built by splitting on '.', so plain decimals (or base-unit integers in the legacy shape) */
export const tronAmount = numeric.transform(toPlainDecimal).refine(isPlainDecimal, AMOUNT_MESSAGE);

/** Solana: the services run parseFloat, so whatever it reads as a non-negative number passes through unchanged */
export const solanaAmount = numeric
    .transform((v) => (typeof v === 'number' ? String(v) : v.trim()))
    .refine((v) => {
        const parsed = parseFloat(v);
        return Number.isFinite(parsed) && parsed >= 0;
    }, 'must be a non-negative number such as "0.1"');

/** Litecoin Core: non-negative, at most 8 decimal places (the node refused anything else) */
export const ltcAmount = numeric
    .transform(toPlainDecimal)
    .refine(isPlainDecimal, AMOUNT_MESSAGE)
    .refine((v) => fractionDigits(v) <= 8, 'must have at most 8 decimal places');

/** null, undefined and blank strings all mean "not provided" */
function optional<T extends z.ZodTypeAny>(schema: T) {
    return z.preprocess(
        (v) => (v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        schema.optional()
    );
}

const text = z.string().trim().min(1, 'must not be empty');

/* Free-form labels: numbers were fine in log lines, so they still are */
const label = optional(numeric.transform((v) => String(v).trim()));

const requestId = label;

/**
 * Flags keep the JavaScript truthiness the handlers always applied: absent means the default, anything else is
 * Boolean(value), so null is false and "false" (a non-empty string) is true, exactly as before.
 */
const truthy = z.unknown().optional();

export function flagOr(value: unknown, fallback: boolean): boolean {
    return value === undefined ? fallback : Boolean(value);
}

function isHttpUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

/** POSTed the final state of the payout (README, Payout journal) */
const callbackUrl = optional(z.string().trim().max(2000).refine(isHttpUrl, 'must be an http(s) URL'));

function isSolanaAddress(value: string): boolean {
    try {
        // eslint-disable-next-line no-new
        new PublicKey(value);
        return true;
    } catch {
        return false;
    }
}

function isSolanaSecret(value: string): boolean {
    try {
        const length = bs58.decode(value).length;
        return length === 64 || length === 32;
    } catch {
        return false;
    }
}

function isEvmPayway(value: string): boolean {
    if (!EVM_PAYWAYS.includes(value)) return false;
    try {
        getChainForPayway(value);
        return getEvmRpcUrlsForPayway(value).length > 0;
    } catch {
        return false;
    }
}

const evmAddress = z.string().trim().refine((v) => isAddress(v), 'must be an EVM address (0x and 40 hex characters, valid checksum if mixed case)');
const solanaAddress = z.string().trim().refine(isSolanaAddress, 'must be a base58 Solana address');
const tronAddress = z.string().trim().refine((v) => TronWeb.isAddress(v), 'must be a Tron address');

const hexPrivateKey = z.string().trim().refine((v) => /^(0x)?[0-9a-fA-F]{64}$/.test(v), 'must be a 32-byte hex private key');
const solanaPrivateKey = z.string().trim().refine(isSolanaSecret, 'must be a base58 secret key (64 bytes) or seed (32 bytes)');

const evmPayway = z.string().trim().toLowerCase()
    .refine(isEvmPayway, `is not a supported EVM payway (supported: ${EVM_PAYWAYS.join(', ')})`);

/* ----------------------------------------------------------------- EVM */

export const evmPayoutSchema = z.object({
    payway: evmPayway,
    payee_address: evmAddress,
    amount: evmAmount,
    contract: optional(evmAddress),
    currency: label,
    private_key: hexPrivateKey,
    wait_for_receipt: truthy,
    request_id: requestId,
    callback_url: callbackUrl
});

export const evmMultiSendSchema = z.object({
    payway: evmPayway,
    recipients: z.array(z.object({ address: evmAddress, amount: evmAmount })),
    private_key: hexPrivateKey,
    currency: label,
    multi_send_contract: evmAddress,
    wait_for_receipt: truthy,
    request_id: requestId,
    callback_url: callbackUrl
});

export const evmBatchSendSchema = z.object({
    payway: evmPayway,
    private_key: hexPrivateKey,
    currency: label,
    batch_send_contract: evmAddress,
    native_transfers: optional(z.array(z.object({ to: evmAddress, amount: evmAmount }))),
    token_transfers: optional(z.array(z.object({ token_address: evmAddress, to: evmAddress, amount: evmAmount }))),
    request_id: requestId,
    callback_url: callbackUrl
});

/** `destination` is checked in the route first, keeping its original error message */
export const bridgeSchema = z.object({
    destination: z.string().trim().toLowerCase(),
    private_key: hexPrivateKey,
    amount: evmAmount,
    payee_address: optional(evmAddress),
    currency: label,
    wait_for_receipt: truthy,
    request_id: requestId,
    callback_url: callbackUrl
});

/* ----------------------------------------------------------------- Litecoin */

export const ltcPayoutSchema = z.object({
    // The method used to be forwarded to the node as is; only the payout call is allowed now
    method: optional(z.string().trim().refine((m) => m === 'sendtoaddress', 'only "sendtoaddress" is supported here')),
    payee_address: text,
    amount: ltcAmount,
    payway: optional(text),
    currency: label,
    request_id: requestId,
    callback_url: callbackUrl
});

export const ltcMultiSendSchema = z.object({
    // Always sendmany; the field is accepted for compatibility and ignored
    method: z.unknown().optional(),
    payway: optional(text),
    currency: label,
    // Shapes only: the service validates each amount itself (parseFloat, > 0) exactly as before
    recipients: z.union([
        z.array(z.object({ address: z.string(), amount: numeric })),
        z.record(z.string(), numeric)
    ]),
    comment: optional(z.string()),
    minconf: optional(z.number().int().min(0)),
    account: optional(z.string().trim()),
    request_id: requestId,
    callback_url: callbackUrl
});

/* ----------------------------------------------------------------- Solana */

export const solanaPayoutSchema = z.object({
    payway: optional(text),
    private_key: solanaPrivateKey,
    currency: label,
    amount: solanaAmount,
    payee_address: solanaAddress,
    token_mint: optional(solanaAddress),
    is_token_2022: truthy,
    request_id: requestId,
    callback_url: callbackUrl
});

export const solanaIntermediateAtaSchema = solanaPayoutSchema.extend({
    token_mint: solanaAddress
});

export const solanaMultiSendSchema = z.object({
    private_key: solanaPrivateKey,
    currency: label,
    token_mint: optional(solanaAddress),
    recipients: z.array(z.object({ address: solanaAddress, amount: solanaAmount })),
    request_id: requestId,
    callback_url: callbackUrl
});

export const solanaCreateTokenAccountSchema = z.object({
    payway: optional(text),
    private_key: solanaPrivateKey,
    token_mint: solanaAddress,
    owner_address: solanaAddress
});

/* ----------------------------------------------------------------- Tron */

/** Validates the payload after TronPayoutService.normalizeTronPayload (current and legacy shapes) */
export const tronPayoutSchema = z.object({
    payway: text,
    private_key: hexPrivateKey,
    currency: label,
    payee_address: tronAddress,
    amount: tronAmount,
    contract: optional(tronAddress),
    isLegacy: z.boolean(),
    wait_for_receipt: truthy,
    request_id: requestId,
    callback_url: callbackUrl
});

export const tronMultiSendSchema = z.object({
    payway: text,
    private_key: hexPrivateKey,
    currency: label,
    multi_send_contract: tronAddress,
    recipients: z.array(z.object({ address: tronAddress, amount: tronAmount })),
    token_contract: optional(tronAddress),
    wait_for_receipt: truthy,
    request_id: requestId,
    callback_url: callbackUrl
});

/* ----------------------------------------------------------------- Payout journal */

export const payoutListQuerySchema = z.object({
    status: optional(z.enum(['pending', 'submitted', 'succeeded', 'failed', 'unknown'])),
    chain: optional(z.string().trim()),
    endpoint: optional(z.string().trim()),
    request_id: optional(z.string().trim()),
    before: optional(z.string().trim()),
    limit: optional(z.coerce.number().int().min(1).max(500))
});

/**
 * Parses `{ data: ... }` request bodies. Throws ZodError, which the error handler turns into a 400 naming the field.
 */
export function parseData<T extends z.ZodTypeAny>(schema: T, body: unknown): z.output<T> {
    const envelope = z.object({ data: schema }).parse(body ?? {}) as { data: z.output<T> };
    return envelope.data;
}
