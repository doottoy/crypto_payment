/* External dependencies */
import fetch from 'node-fetch';
import {
    Asset,
    Horizon,
    Keypair,
    Memo,
    MuxedAccount,
    Networks,
    Operation,
    StrKey,
    Transaction,
    TransactionBuilder,
    xdr
} from '@stellar/stellar-sdk';

/* Internal dependencies */
import { logger } from './logger';

/* Constants */
import { Const } from '../constants/const';

/**
 * HTTP status for the codes that are NOT the caller's fault. Everything else
 * describes a bad request and defaults to 400 — but an unknown or merely
 * delayed settlement must never be dressed up as a client error, or a caller
 * that treats 4xx as permanent will drop a payout it should have retried (or
 * retry one it must first reconcile by hash).
 */
const NON_CLIENT_ERROR_STATUS: Record<string, number> = {
    submission_expired: 503,
    submission_indeterminate: 502,
    transaction_failed_on_chain: 502,
    friendbot_failed: 502
};

/**
 * Typed error for Stellar payouts. `code` is a stable machine-readable
 * identifier surfaced to API callers alongside the human-readable message.
 */
export class StellarPayoutError extends Error {
    readonly statusCode: number;

    constructor(readonly code: string, message: string) {
        super(message);
        this.name = 'StellarPayoutError';
        this.statusCode = NON_CLIENT_ERROR_STATUS[code] ?? 400;
    }
}

/**
 * Creates a Horizon server instance pointed at the configured network.
 */
export function createHorizonServer(): Horizon.Server {
    return new Horizon.Server(Const.STELLAR_HORIZON);
}

/**
 * True when the service is configured against the SDF testnet.
 * Auto-heal must never run outside of it.
 */
export function isStellarTestnet(): boolean {
    return Const.STELLAR_NETWORK_PASSPHRASE === Networks.TESTNET;
}

/**
 * True when lazy self-healing of sender accounts is allowed
 * (explicit env opt-in AND the network is the testnet).
 */
export function isAutoHealEnabled(): boolean {
    return process.env.STELLAR_AUTO_HEAL === 'true' && isStellarTestnet();
}

/**
 * Parses and validates the sender secret seed (S...).
 */
export function keypairFromSecret(secret: string): Keypair {
    if (typeof secret !== 'string' || !StrKey.isValidEd25519SecretSeed(secret)) {
        throw new StellarPayoutError('invalid_private_key', 'private_key is not a valid Stellar secret seed (S...)');
    }
    return Keypair.fromSecret(secret);
}

/**
 * Validates a decimal amount string: positive, at most 7 decimal places
 * (the protocol-wide precision of every Stellar asset).
 */
export function validateStellarAmount(amount: string, context = 'amount'): void {
    if (typeof amount !== 'string' || !/^\d+(\.\d{1,7})?$/.test(amount)) {
        throw new StellarPayoutError('invalid_amount', `${context} "${amount}" must be a positive decimal string with at most 7 decimal places`);
    }
    if (toStroops(amount) <= 0n) {
        throw new StellarPayoutError('invalid_amount', `${context} must be greater than zero`);
    }
}

/**
 * Converts a decimal amount string to stroops (1 XLM = 10^7 stroops)
 * for exact integer comparisons.
 */
export function toStroops(amount: string): bigint {
    const [integerPart, fractionPart = ''] = amount.split('.');
    return BigInt(integerPart + fractionPart.padEnd(7, '0'));
}

/**
 * Resolves the asset to pay with. A Stellar asset is the pair
 * (code, issuer) — the code alone is not unique on the network.
 * Accepts either explicit fields or the combined "CODE:ISSUER" contract
 * form kept for parity with the EVM/Tron request shape.
 * No asset fields at all means native XLM.
 */
export function buildStellarAsset(assetCode?: string, assetIssuer?: string, contract?: string): Asset {
    let code = assetCode;
    let issuer = assetIssuer;

    if (!code && !issuer && contract) {
        const [contractCode, contractIssuer] = contract.split(/[:\-]/);
        code = contractCode;
        issuer = contractIssuer;
    }

    if (!issuer && (!code || code.toUpperCase() === 'XLM')) {
        return Asset.native();
    }

    if (!code || !issuer) {
        throw new StellarPayoutError('invalid_asset', 'both asset_code and asset_issuer are required for a non-native asset');
    }

    if (!StrKey.isValidEd25519PublicKey(issuer)) {
        throw new StellarPayoutError('invalid_asset', `asset_issuer "${issuer}" is not a valid Stellar public key (G...)`);
    }

    try {
        return new Asset(code, issuer);
    } catch (error) {
        throw new StellarPayoutError('invalid_asset', `invalid asset "${code}": ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Validates the destination address and resolves the underlying account id.
 * Supports regular G... addresses and muxed M... addresses (the base G
 * account is used for existence/trustline pre-flight checks).
 */
export function resolveStellarDestination(address: string): { destination: string; baseAccountId: string } {
    if (typeof address === 'string' && StrKey.isValidEd25519PublicKey(address)) {
        return { destination: address, baseAccountId: address };
    }

    if (typeof address === 'string' && StrKey.isValidMed25519PublicKey(address)) {
        const muxed = MuxedAccount.fromAddress(address, '0');
        return { destination: address, baseAccountId: muxed.baseAccount().accountId() };
    }

    throw new StellarPayoutError('invalid_address', `payee_address "${address}" is not a valid Stellar address (G... or M...)`);
}

/** Memo flavours this service can build. */
const SUPPORTED_MEMO_TYPES = ['text', 'id'] as const;

/**
 * Builds the transaction memo from request fields. An unrecognised memo_type is
 * rejected rather than silently downgraded to a text memo: a deposit that the
 * receiver expects to match on MEMO_ID is credited to nobody when it arrives as
 * MEMO_TEXT, which is exactly the loss the SEP-29 check below guards against.
 */
export function buildStellarMemo(memo?: string, memoType: string = 'text'): Memo | undefined {
    if (memo === undefined || memo === null || memo === '') {
        return undefined;
    }

    if (!(SUPPORTED_MEMO_TYPES as readonly string[]).includes(memoType)) {
        throw new StellarPayoutError(
            'invalid_memo_type',
            `memo_type "${memoType}" is not supported; use one of: ${SUPPORTED_MEMO_TYPES.join(', ')}`
        );
    }

    try {
        return memoType === 'id' ? Memo.id(memo) : Memo.text(memo);
    } catch (error) {
        throw new StellarPayoutError('invalid_memo', `invalid ${memoType} memo "${memo}": ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Loads an account or returns null when it does not exist on the ledger
 * (e.g. never funded, merged away, or wiped by a testnet reset).
 */
export async function loadAccountOrNull(server: Horizon.Server, accountId: string): Promise<Horizon.AccountResponse | null> {
    try {
        return await server.loadAccount(accountId);
    } catch (error: any) {
        if (error?.response?.status === 404 || error?.name === 'NotFoundError') {
            return null;
        }
        throw error;
    }
}

/**
 * Finds the trustline entry of `asset` on an account, or null.
 */
export function findTrustline(account: Horizon.AccountResponse, asset: Asset): { balance: string; limit: string } | null {
    const line = (account.balances as any[]).find(
        (b) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer()
    );
    return line ? { balance: line.balance, limit: line.limit } : null;
}

/**
 * Extracts Horizon result codes ({ transaction, operations[] }) from a
 * failed submitTransaction error, if present.
 */
export function extractResultCodes(error: any): { transaction?: string; operations?: string[] } | null {
    return error?.response?.data?.extras?.result_codes ?? null;
}

/** Human-readable hints for the most common Stellar result codes. */
const RESULT_CODE_HINTS: Record<string, string> = {
    op_no_trust: 'destination has no trustline for this asset',
    op_no_destination: 'destination account does not exist',
    op_underfunded: 'sender balance is insufficient',
    op_line_full: 'destination trustline limit would be exceeded',
    op_low_reserve: 'balance would drop below the XLM reserve requirement',
    op_no_issuer: 'asset issuer account does not exist',
    op_not_authorized: 'sender or destination is not authorized by the asset issuer',
    tx_bad_seq: 'sequence number mismatch (concurrent sends from the same account?)',
    tx_insufficient_fee: 'fee bid too low (network surge pricing)',
    tx_too_late: 'transaction timebounds expired before inclusion',
    tx_insufficient_balance: 'sender cannot cover the fee'
};

/**
 * Produces a stable, human-readable description of a Horizon/Stellar error.
 */
export function describeStellarError(error: any): string {
    const codes = extractResultCodes(error);
    if (codes) {
        const parts: string[] = [];
        if (codes.transaction) {
            const hint = RESULT_CODE_HINTS[codes.transaction];
            parts.push(`tx=${codes.transaction}${hint ? ` (${hint})` : ''}`);
        }
        if (codes.operations?.length) {
            const described = codes.operations.map((code, index) => {
                const hint = RESULT_CODE_HINTS[code];
                return code === 'op_success' ? `#${index}:ok` : `#${index}:${code}${hint ? ` (${hint})` : ''}`;
            });
            parts.push(`ops=[${described.join(', ')}]`);
        }
        return parts.join(' ');
    }
    return error?.message || String(error);
}

/**
 * Funds a brand-new account via Friendbot (testnet only). Friendbot can only
 * CREATE accounts — it cannot top up an existing one.
 */
export async function fundWithFriendbot(accountId: string): Promise<void> {
    const response = await fetch(`${Const.STELLAR_FRIENDBOT}?addr=${encodeURIComponent(accountId)}`);
    if (!response.ok) {
        throw new StellarPayoutError('friendbot_failed', `friendbot funding of ${accountId} failed with HTTP ${response.status}`);
    }
}

/**
 * Outcome of a submitted transaction. Callers only need the hash; `successful`
 * is carried for transactions resolved by polling rather than by a submit reply.
 */
export interface StellarSubmitResult {
    hash: string;
    successful?: boolean;
}

/**
 * Per-source-account submission queue.
 *
 * Stellar has no mempool nonce gap tolerance: a transaction's sequence number
 * must be exactly current+1, and `loadAccount` reports LEDGER state, so two
 * concurrent submissions from one account both read the same sequence. Worse,
 * two concurrent payouts with identical operations produce byte-identical
 * transactions (same sequence, same ops, same-second timebounds, deterministic
 * ed25519 signature) — hence one hash, one on-chain payment, and a success
 * reply for BOTH callers with only one of them actually paid. Serializing per
 * source account is what makes N concurrent payouts settle as N payments.
 *
 * In-memory, so it only serializes within a single process instance — the same
 * caveat the EVM nonce allocator carries.
 */
const submissionQueues = new Map<string, Promise<void>>();

async function withSourceAccountLock<T>(accountId: string, task: () => Promise<T>): Promise<T> {
    const previous = submissionQueues.get(accountId) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
        release = resolve;
    });

    submissionQueues.set(accountId, previous.then(() => current));
    await previous;
    try {
        return await task();
    } finally {
        release();
        if (submissionQueues.get(accountId) === current) {
            submissionQueues.delete(accountId);
        }
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Asks Horizon whether a transaction hash made it into a ledger.
 * Distinguishes "definitely not there" from "could not find out".
 */
async function probeTransaction(server: Horizon.Server, hash: string): Promise<StellarSubmitResult | 'absent' | 'unknown'> {
    try {
        const record = await server.transactions().transaction(hash).call();
        return { hash: record.hash, successful: record.successful };
    } catch (error: any) {
        if (error?.response?.status === 404 || error?.name === 'NotFoundError') {
            return 'absent';
        }
        return 'unknown';
    }
}

/**
 * Resolves a submission whose reply was lost (Horizon 504, dropped socket,
 * read timeout). Such a transaction may still be applied by the network, so
 * treating it as failed is what makes a client retry pay twice. Horizon's own
 * 504 body says as much: poll the hash instead.
 *
 * Because the transaction carries timebounds, the outcome is decidable: once
 * maxTime has passed it can never be included again, so a definite 404 after
 * expiry proves nothing was paid out.
 */
async function resolveLostSubmission(
    server: Horizon.Server,
    transaction: Transaction,
    hash: string,
    cause: unknown
): Promise<StellarSubmitResult> {
    const maxTimeMs = Number(transaction.timeBounds?.maxTime ?? 0) * 1000;
    const expiresAt = (maxTimeMs > 0 ? maxTimeMs : Date.now() + Const.STELLAR_TX_TIMEOUT_SEC * 1000)
        + Const.STELLAR_SUBMIT_RESOLVE_GRACE_MS;

    logger.warn('STELLAR', `submission reply lost (${describeStellarError(cause)}); polling ${hash} until its timebounds expire`);

    let lastProbe: 'absent' | 'unknown' = 'unknown';
    for (;;) {
        const probe = await probeTransaction(server, hash);
        if (typeof probe === 'object') {
            if (probe.successful === false) {
                throw new StellarPayoutError(
                    'transaction_failed_on_chain',
                    `transaction ${hash} was included but failed on-chain; the fee was consumed and nothing was paid out`
                );
            }
            logger.info('STELLAR', `lost submission resolved: ${hash} did land`);
            return probe;
        }

        lastProbe = probe;
        if (Date.now() >= expiresAt) {
            break;
        }
        await delay(Const.STELLAR_SUBMIT_POLL_INTERVAL_MS);
    }

    if (lastProbe === 'absent') {
        throw new StellarPayoutError(
            'submission_expired',
            `transaction ${hash} was never included and its timebounds have expired; nothing was paid out and the request can be safely retried`
        );
    }

    throw new StellarPayoutError(
        'submission_indeterminate',
        `could not determine whether transaction ${hash} was applied; check that hash on Horizon before resubmitting, a blind retry may pay twice`
    );
}

/**
 * Builds, signs and submits a transaction with the given operations, serialized
 * per source account. Applies timebounds (Const.STELLAR_TX_TIMEOUT_SEC) so a
 * stuck submission can always be retried safely after expiry, resolves lost
 * replies by polling the transaction hash, and retries once on tx_bad_seq.
 * When no memo is set, enforces the SEP-29 "memo required" check so payouts
 * to exchange deposit accounts are not lost.
 */
export async function submitStellarTransaction(
    server: Horizon.Server,
    sourceKeypair: Keypair,
    operations: xdr.Operation[],
    memo?: Memo
): Promise<StellarSubmitResult> {
    // The lock spans load-sequence -> build -> sign -> submit -> outcome, since
    // the sequence number is only spent once the transaction is in a ledger.
    return withSourceAccountLock(sourceKeypair.publicKey(), () =>
        submitOnce(server, sourceKeypair, operations, memo, true)
    );
}

async function submitOnce(
    server: Horizon.Server,
    sourceKeypair: Keypair,
    operations: xdr.Operation[],
    memo: Memo | undefined,
    retryOnBadSeq: boolean
): Promise<StellarSubmitResult> {
    const sourceAccount = await loadAccountOrNull(server, sourceKeypair.publicKey());
    if (!sourceAccount) {
        throw new StellarPayoutError(
            'sender_account_not_found',
            `sender ${sourceKeypair.publicKey()} does not exist on the ledger; fund it before paying out (a Stellar account must be created and hold the XLM reserve)`
        );
    }

    const builder = new TransactionBuilder(sourceAccount, {
        fee: Const.STELLAR_BASE_FEE,
        networkPassphrase: Const.STELLAR_NETWORK_PASSPHRASE
    });
    for (const operation of operations) {
        builder.addOperation(operation);
    }
    if (memo) {
        builder.addMemo(memo);
    }
    const transaction = builder.setTimeout(Const.STELLAR_TX_TIMEOUT_SEC).build();

    if (!memo) {
        try {
            await server.checkMemoRequired(transaction);
        } catch (error: any) {
            if (isMemoRequiredError(error)) {
                throw memoRequiredError(error);
            }
            // Network hiccups during the check must not block the payout itself;
            // submitTransaction runs the same check again, so nothing is skipped.
            logger.warn('STELLAR', `SEP-29 memo-required check inconclusive: ${error?.message || String(error)}`);
        }
    }

    transaction.sign(sourceKeypair);
    // Computed locally and deterministically, so the outcome of a lost reply
    // stays discoverable.
    const hash = transaction.hash().toString('hex');

    try {
        return await server.submitTransaction(transaction);
    } catch (error: any) {
        if (isMemoRequiredError(error)) {
            throw memoRequiredError(error);
        }

        const codes = extractResultCodes(error);

        if (retryOnBadSeq && codes?.transaction === 'tx_bad_seq') {
            // With the per-account lock in place this means someone else is
            // signing for this account; confirm our attempt really did not
            // land before spending a fresh sequence on the same payment.
            const probe = await probeTransaction(server, hash);
            if (typeof probe === 'object') {
                return probe;
            }
            logger.warn('STELLAR', 'tx_bad_seq received, rebuilding with a fresh sequence and retrying once');
            return submitOnce(server, sourceKeypair, operations, memo, false);
        }

        if (!codes) {
            // No result codes means Horizon never told us the verdict.
            return resolveLostSubmission(server, transaction, hash, error);
        }

        throw error;
    }
}

/** SEP-29 rejection raised either by our pre-check or by the SDK's own check. */
function isMemoRequiredError(error: any): boolean {
    return error?.constructor?.name === 'AccountRequiresMemoError';
}

function memoRequiredError(error: any): StellarPayoutError {
    return new StellarPayoutError(
        'destination_requires_memo',
        `destination ${error?.accountId ?? ''} requires a transaction memo (SEP-29); payout without memo would be unattributable`
    );
}

/**
 * Lazy self-heal of the SENDER account (testnet only, env opt-in):
 *  - account wiped by a quarterly testnet reset -> re-fund via Friendbot;
 *  - missing trustline for the asset -> re-open it (we hold the sender key);
 *  - insufficient balance of an asset issued by STELLAR_ISSUER_SECRET -> mint the deficit.
 * Never runs outside the testnet; see isAutoHealEnabled().
 */
export async function healSenderAccount(
    server: Horizon.Server,
    senderKeypair: Keypair,
    asset: Asset,
    requiredStroops: bigint,
    payway: string
): Promise<void> {
    if (!isAutoHealEnabled()) {
        return;
    }

    const network = payway.toUpperCase();
    const senderId = senderKeypair.publicKey();

    let account = await loadAccountOrNull(server, senderId);
    if (!account) {
        logger.warn(network, `[AUTO_HEAL] sender ${senderId} not found (testnet reset?) — funding via friendbot`);
        await fundWithFriendbot(senderId);
        account = await server.loadAccount(senderId);
    }

    if (asset.isNative()) {
        return;
    }

    let trustline = findTrustline(account, asset);
    if (!trustline) {
        logger.warn(network, `[AUTO_HEAL] sender trustline for ${asset.getCode()} missing — re-opening`);
        await submitStellarTransaction(server, senderKeypair, [Operation.changeTrust({ asset })]);
        trustline = { balance: '0', limit: '0' };
    }

    const issuerSecret = process.env.STELLAR_ISSUER_SECRET;
    if (!issuerSecret) {
        return;
    }

    const deficit = requiredStroops - toStroops(trustline.balance);
    if (deficit <= 0n) {
        return;
    }

    const issuerKeypair = keypairFromSecret(issuerSecret);
    if (issuerKeypair.publicKey() !== asset.getIssuer()) {
        return;
    }

    const deficitDecimal = stroopsToDecimal(deficit);
    logger.warn(network, `[AUTO_HEAL] sender is short ${deficitDecimal} ${asset.getCode()} — minting from the test issuer`);
    await submitStellarTransaction(server, issuerKeypair, [
        Operation.payment({ destination: senderId, asset, amount: deficitDecimal })
    ]);
}

/**
 * Converts stroops back to a decimal string.
 */
export function stroopsToDecimal(stroops: bigint): string {
    const negative = stroops < 0n;
    const absolute = negative ? -stroops : stroops;
    const padded = absolute.toString().padStart(8, '0');
    const integerPart = padded.slice(0, -7);
    const fractionPart = padded.slice(-7).replace(/0+$/, '');
    const value = fractionPart ? `${integerPart}.${fractionPart}` : integerPart;
    return negative ? `-${value}` : value;
}
