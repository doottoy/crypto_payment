/**
 * Base structure for LTC request data.
 */
export interface LtcBaseRequestData {
    method: string;
    payee_address: string;
    amount: number;
    payway: string;
    currency: string;
}

/**
 * Structure for a single LTC payout request.
 */
export interface LtcSinglePayoutRequestBody {
    data: LtcBaseRequestData;
}

/**
 * Structure for a single LTC payout request, including metadata for the test, request method,
 * and response data.
 */
export interface LtcSinglePayoutRequest {
    testName: string;
    tag: string;
    method: string;
    requestBody: LtcSinglePayoutRequestBody;
    responseData: {
        tx_id: string;
    };
    responseCode: string;
}

/**
 * Structure for a multi LTC payout request.
 */
export interface LtcSendManyRequestBody {
    method: string;
    payway: string;
    currency: string;
    recipients: Record<string, number>; // Map of address to amount
    comment: string;
    minconf: number;
}

/**
 * Structure for a multi LTC payout request.
 */
export interface LtcMultiPayoutRequestBody {
    data: LtcSendManyRequestBody;
}

/**
 * Structure for a multi LTC payout request, including metadata for the test, request method,
 * and response data.
 */
export interface LtcMultiPayoutRequest {
    testName: string;
    tag: string;
    method: string;
    requestBody: LtcMultiPayoutRequestBody;
    responseData: {
        tx_id: string;
    };
    responseCode: string;
}
