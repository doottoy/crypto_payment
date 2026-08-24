/* Internal dependencies */
import { BaseRequestBody, Recipient } from './payout.interface';

/**
 * Asset addressing for Stellar payouts. A Stellar asset is identified by the
 * pair (asset_code, asset_issuer) — the code alone is NOT unique on the network.
 * When both fields are omitted the payout is sent in native XLM.
 */
export interface StellarAssetFields {
    asset_code?: string;
    asset_issuer?: string;
    /** Alternative single-field form: "CODE:ISSUER" (kept for parity with EVM/Tron `contract`). */
    contract?: string;
    /** Transaction memo. One memo per transaction (protocol constraint). */
    memo?: string;
    /**
     * Memo flavour: 'text' (default, <=28 bytes) or 'id' (uint64 as string).
     * Typed as a plain string because the value arrives unvalidated from the
     * request body; anything else is rejected rather than coerced to text.
     */
    memo_type?: string;
}

/**
 * Structure for a single Stellar payout transaction request.
 */
export interface StellarPayoutRequestBody {
    data: BaseRequestBody & StellarAssetFields & {
        payee_address: string;
        amount: string;
    };
}

/**
 * Structure for a multi-payout (up to 100 payments in one atomic transaction)
 * Stellar request. All recipients share the same asset and the same memo.
 */
export interface StellarMultiPayoutRequestBody {
    data: BaseRequestBody & StellarAssetFields & {
        recipients: Recipient[];
    };
}

/**
 * Normalized per-call options passed from routes into the Stellar services.
 */
export interface StellarSendOptions {
    assetCode?: string;
    assetIssuer?: string;
    contract?: string;
    memo?: string;
    memoType?: string;
    requestId?: string;
}
