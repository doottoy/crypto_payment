/**
 * Common structure for request data related to a payment transaction.
 */
export interface BaseRequestData {
    payway: string;
    currency: string;
    private_key: string;
}

/**
 * Structure for holding request data related to a single payment transaction.
 */
export interface SinglePayoutRequestData extends BaseRequestData {
    amount: string;
    payee_address: string;
    contract: string;
}

/**
 * Structure for a request body containing payment data for a single transaction.
 */
export interface SinglePayoutRequestBody {
    data: SinglePayoutRequestData;
}

/**
 * Structure for a single payment request, including metadata for the test, request method,
 * and response data. Provides a comprehensive overview of the request and its expected outcomes.
 */
export interface SinglePayoutRequest {
    testName: string;
    tag: string;
    method: string;
    requestBody: SinglePayoutRequestBody;
    responseData: {
        tx_id: string;
    };
    responseCode: string;
}

/**
 * Structure for holding recipient information in a multi-payout transaction.
 */
export interface Recipient {
    address: string;
    amount: number;
}

/**
 * Structure for holding request data related to a multi-payout transaction.
 */
export interface MultiPayoutRequestData extends BaseRequestData {
    multi_send_contract: string;
    recipients: Recipient[];
}

/**
 * Structure for a request body containing payment data for a multi-payout transaction.
 */
export interface MultiPayoutRequestBody {
    data: MultiPayoutRequestData;
}

/**
 * Structure for a multi-payment request, including metadata for the test, request method,
 * and response data. Provides a comprehensive overview of the request and its expected outcomes.
 */
export interface MultiPayoutRequest {
    testName: string;
    tag: string;
    method: string;
    requestBody: MultiPayoutRequestBody;
    responseData: {
        tx_id: string;
    };
    responseCode: string;
}

