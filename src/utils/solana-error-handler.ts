/* External dependencies */
import { SendTransactionError } from '@solana/web3.js';

/**
 * Formats Solana transaction errors into human-readable messages.
 *
 * @param error - The error object thrown during transaction.
 * @param currency - The currency involved in the transaction.
 * @returns A formatted error message.
 */
export function formatSolanaError(error: any): string {
    if (error instanceof SendTransactionError) {
        // Extract logs from the error
        const logs = error.logs;

        if (logs) {
            // Initialize variables to hold extracted information
            let errorMessage = '';

            // Check for specific error patterns
            for (const log of logs) {
                if (log.includes('insufficient lamports') || log.includes('insufficient funds')) {
                    const match = log.match(/insufficient lamports (\d+), need (\d+)/) ||
                        log.match(/insufficient funds/);
                    if (match) {
                        if (match.length === 3) {
                            const available = Number(match[1]);
                            const required = Number(match[2]);
                            errorMessage = `Insufficient funds, need ensure wallet has enough SOL to cover the transaction and fees.\nAvailable = ${available} lamports\nRequired = ${required} lamports`;
                            break;
                        } else {
                            errorMessage = `Insufficient funds, need ensure wallet has enough SOL/SPL to cover the token transfer transaction and fees.`;
                            break;
                        }
                    }
                }

                if (log.includes('custom program error')) {
                    const match = log.match(/custom program error: (\w+)/);
                    if (match && match.length === 2) {
                        const errorCode = match[1];
                        // Map known error codes to messages
                        const errorMap: { [key: string]: string } = {
                            '0x1': 'Unknown error occurred in the program.',
                        };
                        const mappedMessage = errorMap[errorCode] || 'A custom program error occurred.';
                        errorMessage = `${mappedMessage} (Error Code: ${errorCode})`;
                        break;
                    }
                }

                // Handle other specific errors
                if (log.includes('invalid instruction data')) {
                    errorMessage = `Invalid instruction data, need check the transaction parameters.`;
                    break;
                }
            }

            // If a specific error message was constructed, return it
            if (errorMessage) {
                return errorMessage;
            }

            // Fallback to generic message if no specific pattern was matched
            return `${error.message || 'Unknown error'}`;
        }

        // Fallback if logs are not present
        return `${error.message || 'Unknown error'}`;
    }

    // Handle non-SendTransactionError types
    return `An unexpected error occurred: ${error.message || error}`;
}
