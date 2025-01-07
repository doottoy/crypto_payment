/* Constants */
import { Const } from '../constants/const';

/**
 * Formats a success message for a multi-send transaction.
 * @param payway - The payway used for the transaction.
 * @param currency - The currency involved in the transaction.
 * @param transaction - The transaction details, including hash and sender address.
 * @returns A formatted success message string.
 */
function formatSuccessMultiSend(payway: string, currency: string, transaction: any): string {
    // Determine the appropriate explorer link based on the payway
    const explorerLink = Const.BSC_PAYWAY.includes(payway)
        ? Const.TESTNET_EXPLORER.BSC
        : Const.ARBITRUM_PAYWAY.includes(payway)
            ? Const.TESTNET_EXPLORER.ARBITRUM
            : Const.BASE_PAYWAY.includes(payway)
                ? Const.TESTNET_EXPLORER.BASE
                : Const.TESTNET_EXPLORER.ETH;

    // Return a formatted success message
    return `⚙️ Type: Multi Send transaction
⏰ Time: [${new Date().toLocaleString()}]
🌐 Blockchain: ${payway.toUpperCase()}
💸 Currency: ${currency}
📜 Transaction hash: ${transaction.transactionHash}
👤 Address sender: ${transaction.from}
🔍 View in explorer: ${explorerLink}${transaction.transactionHash}`;
}

/**
 * Formats a success message for a multi-send LTC transaction.
 * @param payway - The payway used for the transaction.
 * @param currency - The currency involved in the transaction.
 * @param transaction - The transaction details, including hash.
 * @returns A formatted success message string.
 */
function formatSuccessMultiSendLTC(payway: string, currency: string, transaction: any): string {
    // Return a formatted success message
    return `⚙️ Type: Multi LTC Send transaction
⏰ Time: [${new Date().toLocaleString()}]
🌐 Blockchain: ${payway.toUpperCase()}
💸 Currency: ${currency}
📜 Transaction hash: ${transaction.result}
🔍 View in explorer: ${Const.TESTNET_EXPLORER.LTC}${transaction.result}`;
}

/**
 * Formats a success message for a standard EVM transaction.
 * @param payway - The payway used for the transaction.
 * @param currency - The currency involved in the transaction.
 * @param transaction - The transaction details, including hash and sender address.
 * @returns A formatted success message string.
 */
function formatSuccessEVMTransaction(payway: string, currency: string, transaction: any): string {
    // Determine the appropriate explorer link based on the payway
    const explorerLink = Const.BSC_PAYWAY.includes(payway)
        ? Const.TESTNET_EXPLORER.BSC
        : Const.ARBITRUM_PAYWAY.includes(payway)
            ? Const.TESTNET_EXPLORER.ARBITRUM
            : Const.BASE_PAYWAY.includes(payway)
                ? Const.TESTNET_EXPLORER.BASE
                : Const.TESTNET_EXPLORER.ETH;

    // Return a formatted success message
    return `⚙️ Type: EVM transaction
⏰ Time: [${new Date().toLocaleString()}]
🌐 Blockchain: ${payway.toUpperCase()}
💸 Currency: ${currency}
📜 Transaction hash: ${transaction.transactionHash}
👤 Address sender: ${transaction.from}
🔍 View in explorer: ${explorerLink}${transaction.transactionHash}`;
}

/**
 * Formats a success message for an LTC transaction.
 * @param payway - The payway used for the transaction.
 * @param currency - The currency involved in the transaction.
 * @param transaction - The transaction details, including hash.
 * @returns A formatted success message string.
 */
function formatSuccessLTCTransaction(payway: string, currency: string, transaction: any): string {
    // Return a formatted success message
    return `⚙️ Type: LTC transaction
⏰ Time: [${new Date().toLocaleString()}]
🌐 Blockchain: ${payway.toUpperCase()}
💸 Currency: ${currency}
📜 Transaction hash: ${transaction.result}
🔍 View in explorer: ${Const.TESTNET_EXPLORER.LTC}${transaction.result}`;
}

/**
 * Formats an error message for an EVM transaction.
 * @param payway - The payway used for the transaction.
 * @param currency - The currency involved in the transaction.
 * @param error - The error message.
 * @returns A formatted error message string.
 */
function formatErrorEVM(payway: string, currency: string, error: any): string {
    // Return a formatted error message
    return `❌ Type: Error
🌐 Blockchain: ${payway.toUpperCase()}
💸 Currency: ${currency}
❗ Error: ${JSON.stringify(error)  || 'Unknown error'}`;
}

/**
 * Formats an error message for an LTC transaction.
 * @param payway - The payway used for the transaction.
 * @param currency - The currency involved in the transaction.
 * @param transaction - The transaction details, including hash and error message.
 * @returns A formatted error message string.
 */
function formatErrorLTC(payway: string, currency: string, transaction: any): string {
    // Return a formatted error message
    return `❌ Type: Error
🌐 Blockchain: ${payway.toUpperCase()}
💸 Currency: ${currency}
📜 Transaction hash: ${transaction.result || 'N/A'}
❗ Error: ${transaction.error || 'Unknown error'}`;
}

/**
 * Formats an error message for a multi-send transaction.
 * @param payway - The payway used for the transaction.
 * @param currency - The currency involved in the transaction.
 * @param error - The error message.
 * @returns A formatted error message string.
 */
function formatErrorMultiSend(payway: string, currency: string, error: any): string {
    // Return a formatted error message
    return `❌ Type: Error
🌐 Blockchain: ${payway.toUpperCase()}
💸 Currency: ${currency}
❗ Error: ${JSON.stringify(error) || 'Unknown error'}`;
}

/**
 * Formats an error message for a multi-send LTC transaction.
 * @param payway - The payway used for the transaction.
 * @param currency - The currency involved in the transaction.
 * @param transaction - The transaction details, including hash and error message.
 * @returns A formatted error message string.
 */
function formatErrorMultiSendLTC(payway: string, currency: string, transaction: any): string {
    // Return a formatted error message
    return `❌ Type: Error
🌐 Blockchain: ${payway.toUpperCase()}
💸 Currency: ${currency}
📜 Transaction hash: ${transaction.result || 'N/A'}
❗ Error: ${transaction.error || 'Unknown error'}`;
}

/**
 * Formats a success message for a standard Solana transaction.
 * @param currency - The currency involved in the transaction.
 * @param transaction - The transaction details, including hash and sender address.
 * @param addressSender - Address sender
 * @param amount - The amount to transfer
 * @returns A formatted success message string.
 */
function formatSuccessSolanaTransaction(currency: string, transaction: any, addressSender: string, amount: string): string {
    // Return a formatted success message
    return `⚙️ Type: Solana transaction
⏰ Time: [${new Date().toLocaleString()}]
💰 Amount: ${amount}
💸 Currency: ${currency}
📜 Transaction hash: ${transaction}
👤 Address sender: ${addressSender}
🔍 View in explorer: ${Const.TESTNET_EXPLORER.SOLANA}${transaction}?cluster=devnet`;
}

/**
 * Formats an error message for an Solana transaction.
 * @param currency - The currency involved in the transaction.
 * @param transaction - The transaction details, including hash and error message.
 * @returns A formatted error message string.
 */
function formatErrorSolana(currency: string, error: any): string {
    // Return a formatted error message
    return `❌ Type: Solana Error
💸 Currency: ${currency}
❗ Error: ${error|| 'Unknown error'}`;
}

export const notifierMessage = {
    formatErrorEVM,
    formatErrorLTC,
    formatErrorSolana,
    formatErrorMultiSend,
    formatSuccessMultiSend,
    formatErrorMultiSendLTC,
    formatSuccessMultiSendLTC,
    formatSuccessEVMTransaction,
    formatSuccessLTCTransaction,
    formatSuccessSolanaTransaction
};
