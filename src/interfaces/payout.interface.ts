/**
 * Base structure for payment-related requests, including common fields
 * such as payment gateway identifier, private key, and currency.
 */
export interface BaseRequestBody {
    payway: string;
    private_key: string;
    currency: string;
    wait_for_receipt?: boolean;
    request_id?: string;
}

/**
 * Structure for a single payout transaction request, extending the
 * base request body with additional fields specific to a payout operation.
 */
export interface PayoutRequestBody {
    data: BaseRequestBody & {
        payee_address: string;
        amount: string;
        contract: string;
    };
}

/**
 * Standard recipient payload used across multi-send flows.
 */
export interface Recipient {
    address: string;
    amount: string;
}

/**
 * Structure for a multi-payout transaction request, extending the
 * base request body with fields specific to a multi-payout operation.
 */
export interface MultiPayoutRequestBody {
    data: BaseRequestBody & {
        recipients: Recipient[];
        multi_send_contract: string;
        token_contract?: string;
    };
}

/**
 * Structure for a single native currency transfer in a batch send operation.
 */
export interface NativeTransfer {
    to: string;
    amount: string;
}

/**
 * Structure for a single token transfer in a batch send operation.
 */
export interface TokenTransfer {
    token_address: string;
    to: string;
    amount: string;
}

/**
 * Structure for a batch-payout transaction request.
 * Accepts simplified blockchain names (e.g. 'polygon', 'bsc', 'eth').
 */
export interface BatchPayoutRequestBody {
    data: {
        payway: string;
        private_key: string;
        currency?: string;
        batch_send_contract: string;
        native_transfers?: NativeTransfer[];
        token_transfers?: TokenTransfer[];
        request_id?: string;
    };
}

/**
 * Legacy payout structure for Tron transactions.
 */
export type TronLegacyPayoutRequestBody = {
    from?: string;
    private_key: string;
    to: string;
    amount: string;
    currency: string;
    payway: string;
    contract?: string;
    contract_id?: string;
};

/**
 * Current normalized structure for Tron payout data.
 */
export type TronCurrentPayoutData = {
    payway: string;
    private_key: string;
    currency: string;
    payee_address: string;
    amount: string;
    contract?: string;
};

/**
 * Normalized internal payload for Tron transactions carrying
 * an indicator for legacy requests.
 */
export type TronNormalizedPayload = TronCurrentPayoutData & {
    isLegacy: boolean;
};
