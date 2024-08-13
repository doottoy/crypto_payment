/**
 * Method to get the provider object.
 *
 * @returns An object with an optional `engine` property.
 */
export interface ClosableProvider {
    provider?: {
        engine?: {
            stop(): void;
        };
    };
}

/**
 * Parameters for monitoring and validating transaction confirmations.
 *
 * @property providerUrl - URL of theE EVM provider to connect to the blockchain.
 * @property transactionHash - The hash of the transaction to monitor.
 * @property requiredConfirmations - Number of confirmations required for the transaction to be considered final.
 * @property expectedRecipient - The address expected to receive the transaction funds.
 * @property expectedAmount - The amount of the transaction expected to be transferred.
 * @property expectedContract - Optional, the contract address involved in the transaction, if applicable.
 * @property maxRetries - Optional, the maximum number of retries to check the transaction status before throwing an error. Defaults to 50.
 * @property sleepDuration - Optional, the duration (in milliseconds) to wait between retries when checking the transaction status. Defaults to 5000 ms.
 */
export interface WaitForConfirmationsParams {
    providerUrl: string;
    transactionHash: string;
    requiredConfirmations: number;
    expectedContract?: string;
    maxRetries?: number;
    sleepDuration?: number;
}

/**
 * Parameters for monitoring and validating Litecoin transaction confirmations.
 *
 * @property transactionHash - The hash of the transaction to monitor.
 * @property requiredConfirmations - Number of confirmations required for the transaction to be considered final.
 * @property maxRetries - Optional, the maximum number of retries to check the transaction status before throwing an error. Defaults to 100.
 * @property sleepDuration - Optional, the duration (in milliseconds) to wait between retries when checking the transaction status. Defaults to 5000 ms.
 */
export interface WaitForLtcConfirmationsParams {
    transactionHash: string;
    requiredConfirmations: number;
    maxRetries?: number;
    sleepDuration?: number;
}

