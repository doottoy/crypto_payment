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
 * Request schemas. They are deliberately lenient where the service always was: unknown fields are ignored,
 * null / '' mean "not provided", amounts may come as strings or numbers. They only reject input that could never
 * have produced a payout, so the caller gets a 400 with the field name instead of a hung request or a 500.
 */

const DECIMAL = /^\d+(\.\d+)?$/;

const EVM_PAYWAYS: readonly string[] = [
    ...Const.ETH_PAYWAY,
    ...Const.BSC_PAYWAY,
    ...Const.ARBITRUM_PAYWAY,
    ...Const.BASE_PAYWAY,
    ...Const.POLYGON_PAYWAY
];

/** Number to a plain decimal string: String(0.0000001) would give "1e-7", which no amount parser accepts */
export function toPlainDecimal(value: number): string {
    if (!Number.isFinite(value)) return String(value);
    return value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}

function fractionDigits(value: string): number {
    const fraction = value.split('.')[1] ?? '';
    return fraction.replace(/0+$/, '').length;
}

/** null, undefined and blank strings all mean "not provided" */
function optional<T extends z.ZodTypeAny>(schema: T) {
    return z.preprocess(
        (v) => (v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        schema.optional()
    );
}

const text = z.string().trim().min(1, 'must not be empty');

export const amount = z.union([z.string(), z.number()])
    .transform((v) => (typeof v === 'number' ? toPlainDecimal(v) : v.trim()))
    .refine((v) => DECIMAL.test(v), 'must be a non-negative decimal number such as "0.1"');

const flag = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());

const requestId = optional(z.string().trim().max(200, 'must be at most 200 characters'));

function isSolanaAddress(value: string): boolean {
    try {
        return new PublicKey(value).toBase58() === value;
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
    amount,
    contract: optional(evmAddress),
    currency: optional(z.string().trim()),
    private_key: hexPrivateKey,
    wait_for_receipt: optional(flag),
    request_id: requestId
});

export const evmMultiSendSchema = z.object({
    payway: evmPayway,
    recipients: z.array(z.object({ address: evmAddress, amount })).min(1, 'must list at least one recipient'),
    private_key: hexPrivateKey,
    currency: optional(z.string().trim()),
    multi_send_contract: evmAddress,
    wait_for_receipt: optional(flag),
    request_id: requestId
});

export const evmBatchSendSchema = z.object({
    payway: evmPayway,
    private_key: hexPrivateKey,
    currency: optional(z.string().trim()),
    batch_send_contract: evmAddress,
    native_transfers: optional(z.array(z.object({ to: evmAddress, amount }))),
    token_transfers: optional(z.array(z.object({ token_address: evmAddress, to: evmAddress, amount }))),
    request_id: requestId
}).refine(
    (d) => (d.native_transfers?.length ?? 0) + (d.token_transfers?.length ?? 0) > 0,
    { message: 'needs at least one native or token transfer', path: ['native_transfers'] }
);

export const bridgeSchema = z.object({
    destination: z.string().trim().toLowerCase()
        .refine((d) => Const.BRIDGE_DESTINATIONS.includes(d), `is not a supported bridge destination (supported: ${Const.BRIDGE_DESTINATIONS.join(', ')})`),
    private_key: hexPrivateKey,
    amount,
    payee_address: optional(evmAddress),
    currency: optional(z.string().trim()),
    wait_for_receipt: optional(flag),
    request_id: requestId
});

/* ----------------------------------------------------------------- Litecoin */

const ltcAmount = amount.refine((v) => fractionDigits(v) <= 8, 'must have at most 8 decimal places');

export const ltcPayoutSchema = z.object({
    // The method used to be forwarded to the node as is; only the payout call is allowed now
    method: optional(z.string().trim().refine((m) => m === 'sendtoaddress', 'only "sendtoaddress" is supported here')),
    payee_address: text,
    amount: ltcAmount,
    payway: optional(text),
    currency: optional(text),
    request_id: requestId
});

export const ltcMultiSendSchema = z.object({
    // Always sendmany; the field is accepted for compatibility and ignored
    method: optional(z.string()),
    payway: optional(text),
    currency: optional(text),
    recipients: z.union([
        z.array(z.object({ address: text, amount: ltcAmount })).min(1, 'must list at least one recipient'),
        z.record(z.string(), z.union([z.string(), z.number()]))
            .refine((map) => Object.keys(map).length > 0, 'must list at least one recipient')
    ]),
    comment: optional(z.string()),
    minconf: optional(z.number().int().min(0)),
    account: optional(z.string().trim()),
    request_id: requestId
});

/* ----------------------------------------------------------------- Solana */

export const solanaPayoutSchema = z.object({
    payway: optional(text),
    private_key: solanaPrivateKey,
    currency: optional(z.string().trim()),
    amount,
    payee_address: solanaAddress,
    token_mint: optional(solanaAddress),
    is_token_2022: optional(flag),
    request_id: requestId
});

export const solanaIntermediateAtaSchema = solanaPayoutSchema.extend({
    token_mint: solanaAddress
});

export const solanaMultiSendSchema = z.object({
    private_key: solanaPrivateKey,
    currency: optional(z.string().trim()),
    token_mint: optional(solanaAddress),
    recipients: z.array(z.object({ address: solanaAddress, amount })).min(1, 'must list at least one recipient'),
    request_id: requestId
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
    currency: optional(z.string().trim()),
    payee_address: tronAddress,
    amount,
    contract: optional(tronAddress),
    isLegacy: z.boolean()
});

export const tronMultiSendSchema = z.object({
    payway: text,
    private_key: hexPrivateKey,
    currency: optional(z.string().trim()),
    multi_send_contract: tronAddress,
    recipients: z.array(z.object({ address: tronAddress, amount })).min(1, 'must list at least one recipient'),
    token_contract: optional(tronAddress),
    request_id: requestId
});

/**
 * Parses `{ data: ... }` request bodies. Throws ZodError, which the error handler turns into a 400 naming the field.
 */
export function parseData<T extends z.ZodTypeAny>(schema: T, body: unknown): z.output<T> {
    const envelope = z.object({ data: schema }).parse(body ?? {}) as { data: z.output<T> };
    return envelope.data;
}
