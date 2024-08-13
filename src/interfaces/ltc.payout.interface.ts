/**
 * Interface for a request to send funds via Litecoin Core.
 * This is used for single transactions.
 */
export interface LtcBaseRequestBody {
    method: string;
    payway: string;
    currency: string;
    amount: number;
    payee_address: string;
}

/**
 * Structure for a payout transaction request, extending the
 * base request body with additional fields specific to a payout operation.
 */
export interface LtcPayoutRequestBody {
    data: LtcBaseRequestBody;
}

/**
 * Interface for a request to send multiple transactions via Litecoin Core.
 * This is used for multi-send transactions.
 */
export interface LtcSendManyRequestBody {
    method: string;
    payway: string;
    currency: string;
    recipients: Record<string, number>;
    account?: string;
    comment?: string;
    minconf?: number;
}

/**
 * Structure for a payout transaction request, extending the
 * base request body with additional fields specific to a multi-send operation.
 */
export interface LtcSendManyPayoutRequestBody {
    data: LtcSendManyRequestBody;
}

/**
 * Interface for the RPC response.
 */
export interface RpcResponse<T> {
    result: T;
    error: any;
    id: string;
}
