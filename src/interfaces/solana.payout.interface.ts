/**
 * Base structure for payment-related requests, including common fields
 * such as payment gateway identifier, private key, and currency.
 */
export interface BaseRequestBody {
    payway: string;
    private_key: string;
    currency: string;
    request_id?: string;
}

/**
 * Structure for a single payout transaction request, extending the
 * base request body with additional fields specific to a payout operation.
 */
export interface SolanaPayoutRequestBody {
    data: BaseRequestBody & {
        payee_address: string;
        amount: string;
        token_mint: string,
        is_token_2022: boolean
    };
}
