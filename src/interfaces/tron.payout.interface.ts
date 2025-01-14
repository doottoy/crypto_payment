/**
 * Base structure for payment-related requests, including common fields
 * such as payment gateway identifier, private key, and currency.
 */
export interface BaseRequestBody {
    payway: string;
    private_key: string;
    currency: string;
}

/**
 * Structure for a single payout transaction request, extending the
 * base request body with additional fields specific to a payout operation.
 */
export interface PayoutRequestBody {
    data: BaseRequestBody & {
        payee_address: string;
        amount: string;
        contract: string; // Для EVM это адрес токена, для Tron — TRC20
    };
}

/**
 * Structure for a multi-payout transaction request, extending the
 * base request body with fields specific to a multi-payout operation.
 */
export interface MultiPayoutRequestBody {
    data: BaseRequestBody & {
        recipients: Array<{ address: string; amount: string }>;
        multi_send_contract: string;
    };
}
