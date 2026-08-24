/* Constants */
import { Const } from '../constants/const';

function appendRequestId(message: string, requestId?: string): string {
    return requestId ? `${message}\n🧾 Request ID: ${requestId}` : message;
}

/**
 * Formats a success message for a multi-send transaction.
 * @param payway - The payway used for the transaction.
 * @param currency - The currency involved in the transaction.
 * @param transaction - The transaction details, including hash and sender address.
 * @returns A formatted success message string.
 */
function formatSuccessMultiSend(payway: string, currency: string, transaction: any, requestId?: string): string {
    // Determine the appropriate explorer link based on the payway
    const explorerLink = Const.BSC_PAYWAY.includes(payway)
        ? Const.TESTNET_EXPLORER.BSC
        : Const.ARBITRUM_PAYWAY.includes(payway)
            ? Const.TESTNET_EXPLORER.ARBITRUM
            : Const.BASE_PAYWAY.includes(payway)
                ? Const.TESTNET_EXPLORER.BASE
                : Const.POLYGON_PAYWAY.includes(payway)
                    ? Const.TESTNET_EXPLORER.POLYGON
                    : Const.TESTNET_EXPLORER.ETH;

    // Return a formatted success message
    const message = `⚙️ Type: Multi Send transaction
⏰ Time: [${new Date().toLocaleString()}]
🌐 Blockchain: ${payway.toUpperCase()}
💸 Currency: ${currency}
📜 Transaction hash: ${transaction.transactionHash}
👤 Address sender: ${transaction.from}
🔍 View in explorer: ${explorerLink}${transaction.transactionHash}`;
    return appendRequestId(message, requestId);
}

/**
 * Formats a success message for a multi-send LTC transaction.
 * @param payway - The payway used for the transaction.
 * @param currency - The currency involved in the transaction.
 * @param transaction - The transaction details, including hash.
 * @returns A formatted success message string.
 */
function formatSuccessMultiSendLTC(payway: string, currency: string, transaction: any, requestId?: string): string {
    // Return a formatted success message
    const message = `⚙️ Type: Multi LTC Send transaction
⏰ Time: [${new Date().toLocaleString()}]
🌐 Blockchain: ${payway.toUpperCase()}
💸 Currency: ${currency}
📜 Transaction hash: ${transaction.result}
🔍 View in explorer: ${Const.TESTNET_EXPLORER.LTC}${transaction.result}`;
    return appendRequestId(message, requestId);
}

/**
 * Formats a success message for a standard EVM transaction.
 * @param payway - The payway used for the transaction.
 * @param currency - The currency involved in the transaction.
 * @param transaction - The transaction details, including hash and sender address.
 * @returns A formatted success message string.
 */
function formatSuccessEVMTransaction(payway: string, currency: string, transaction: any, requestId?: string): string {
    // Determine the appropriate explorer link based on the payway
    const explorerLink = Const.BSC_PAYWAY.includes(payway)
        ? Const.TESTNET_EXPLORER.BSC
        : Const.ARBITRUM_PAYWAY.includes(payway)
            ? Const.TESTNET_EXPLORER.ARBITRUM
            : Const.BASE_PAYWAY.includes(payway)
                ? Const.TESTNET_EXPLORER.BASE
                : Const.POLYGON_PAYWAY.includes(payway)
                    ? Const.TESTNET_EXPLORER.POLYGON
                    : Const.TESTNET_EXPLORER.ETH;

    // Return a formatted success message
    const message = `⚙️ Type: EVM transaction
⏰ Time: [${new Date().toLocaleString()}]
🌐 Blockchain: ${payway.toUpperCase()}
💸 Currency: ${currency}
📜 Transaction hash: ${transaction.transactionHash}
👤 Address sender: ${transaction.from}
🔍 View in explorer: ${explorerLink}${transaction.transactionHash}`;
    return appendRequestId(message, requestId);
}

/**
 * Formats a success message for an LTC transaction.
 * @param payway - The payway used for the transaction.
 * @param currency - The currency involved in the transaction.
 * @param transaction - The transaction details, including hash.
 * @returns A formatted success message string.
 */
function formatSuccessLTCTransaction(payway: string, currency: string, transaction: any, requestId?: string): string {
    // Return a formatted success message
    const message = `⚙️ Type: LTC transaction
⏰ Time: [${new Date().toLocaleString()}]
🌐 Blockchain: ${payway.toUpperCase()}
💸 Currency: ${currency}
📜 Transaction hash: ${transaction.result}
🔍 View in explorer: ${Const.TESTNET_EXPLORER.LTC}${transaction.result}`;
    return appendRequestId(message, requestId);
}

/**
 * Formats an error message for an EVM transaction.
 * @param payway - The payway used for the transaction.
 * @param currency - The currency involved in the transaction.
 * @param error - The error message.
 * @returns A formatted error message string.
 */
function formatErrorEVM(payway: string, currency: string, error: any, requestId?: string): string {
    // Return a formatted error message
    const message = `❌ Type: Error
🌐 Blockchain: ${payway.toUpperCase()}
💸 Currency: ${currency}
❗ Error: ${JSON.stringify(error)  || 'Unknown error'}`;
    return appendRequestId(message, requestId);
}

/**
 * Formats an error message for an LTC transaction.
 * @param payway - The payway used for the transaction.
 * @param currency - The currency involved in the transaction.
 * @param transaction - The transaction details, including hash and error message.
 * @returns A formatted error message string.
 */
function formatErrorLTC(payway: string, currency: string, transaction: any, requestId?: string): string {
    // Return a formatted error message
    const message = `❌ Type: Error
🌐 Blockchain: ${payway.toUpperCase()}
💸 Currency: ${currency}
📜 Transaction hash: ${transaction.result || 'N/A'}
❗ Error: ${transaction.error || 'Unknown error'}`;
    return appendRequestId(message, requestId);
}

/**
 * Formats an error message for a multi-send transaction.
 * @param payway - The payway used for the transaction.
 * @param currency - The currency involved in the transaction.
 * @param error - The error message.
 * @returns A formatted error message string.
 */
function formatErrorMultiSend(payway: string, currency: string, error: any, requestId?: string): string {
    // Return a formatted error message
    const message = `❌ Type: Error
🌐 Blockchain: ${payway.toUpperCase()}
💸 Currency: ${currency}
❗ Error: ${JSON.stringify(error) || 'Unknown error'}`;
    return appendRequestId(message, requestId);
}

/**
 * Formats an error message for a multi-send LTC transaction.
 * @param payway - The payway used for the transaction.
 * @param currency - The currency involved in the transaction.
 * @param transaction - The transaction details, including hash and error message.
 * @returns A formatted error message string.
 */
function formatErrorMultiSendLTC(payway: string, currency: string, transaction: any, requestId?: string): string {
    // Return a formatted error message
    const message = `❌ Type: Error
🌐 Blockchain: ${payway.toUpperCase()}
💸 Currency: ${currency}
📜 Transaction hash: ${transaction.result || 'N/A'}
❗ Error: ${transaction.error || 'Unknown error'}`;
    return appendRequestId(message, requestId);
}

/**
 * Formats a success message for a standard Solana transaction.
 * @param currency - The currency involved in the transaction.
 * @param transaction - The transaction details, including hash and sender address.
 * @param addressSender - Address sender
 * @param amount - The amount to transfer
 * @returns A formatted success message string.
 */
function formatSuccessSolanaTransaction(currency: string, transaction: any, addressSender: string, amount: string, requestId?: string): string {
    // Return a formatted success message
    const message = `⚙️ Type: Solana Transaction
⏰ Time: [${new Date().toLocaleString()}]
💰 Amount: ${amount}
💸 Currency: ${currency}
📜 Transaction hash: ${transaction}
👤 Address sender: ${addressSender}
🔍 View in explorer: ${Const.TESTNET_EXPLORER.SOLANA}${transaction}?cluster=devnet`;
    return appendRequestId(message, requestId);
}

/**
 * Formats a success message for a standard Solana transaction.
 * @param currency - The currency involved in the transaction.
 * @param transaction - The transaction details, including hash and sender address.
 * @param addressSender - Address sender
 * @returns A formatted success message string.
 */
function formatSuccessSolanaMultiTransaction(currency: string, transaction: any, addressSender: string, requestId?: string): string {
    // Return a formatted success message
    const message = `⚙️ Type: Solana Multi Transaction
⏰ Time: [${new Date().toLocaleString()}]
💸 Currency: ${currency}
📜 Transaction hash: ${transaction}
👤 Address sender: ${addressSender}
🔍 View in explorer: ${Const.TESTNET_EXPLORER.SOLANA}${transaction}?cluster=devnet`;
    return appendRequestId(message, requestId);
}

/**
 * Formats an error message for Solana transaction.
 * @param currency - The currency involved in the transaction.
 * @param error - The transaction details, including hash and error message.
 * @returns A formatted error message string.
 */
function formatErrorSolana(currency: string, error: any, requestId?: string): string {
    // Return a formatted error message
    const message = `❌ Type: Solana Error
💸 Currency: ${currency}
❗ Error: ${error|| 'Unknown error'}`;
    return appendRequestId(message, requestId);
}

/**
 * Formats a success message for a standard Tron transaction.
 * @param currency - The currency involved in the transaction.
 * @param transaction - The transaction details, including hash and sender address.
 * @param addressSender - Address sender
 * @param amount - The amount to transfer
 * @returns A formatted success message string.
 */
function formatSuccessTronTransaction(amount: string, addressSender: string, currency: any, transaction: any, requestId?: string): string {
    // Return a formatted success message
    const message = `⚙️ Type: Tron transaction
⏰ Time: [${new Date().toLocaleString()}]
💰 Amount: ${amount}
💸 Currency: ${currency}
👤 Address sender: ${addressSender}
📜 Transaction hash: ${transaction}
🔍 View in explorer: ${Const.TESTNET_EXPLORER.NILE_TRON}${transaction}`;
    return appendRequestId(message, requestId);
}

/**
 * Formats an error message for Tron transaction.
 * @param currency - The currency involved in the transaction.
 * @param error - The transaction details, including hash and error message.
 * @returns A formatted error message string.
 */
function formatErrorTron(currency: string, error: any, requestId?: string): string {
    // Return a formatted error message
    const message = `❌ Type: Tron Error
💸 Currency: ${currency}
❗ Error: ${error|| 'Unknown error'}`;
    return appendRequestId(message, requestId);
}

/**
 * Formats a success message for a standard Tron multi send transaction.
 * @param currency - The currency involved in the transaction.
 * @param transaction - The transaction details, including hash and sender address.
 * @param addressSender - Address sender
 * @returns A formatted success message string.
 */
function formatSuccessTronMultiSendTransaction(currency: any, transaction: any, requestId?: string): string {
    // Return a formatted success message
    const message = `⚙️ Type: Tron Multi Send Transaction
⏰ Time: [${new Date().toLocaleString()}]
💸 Currency: ${currency}
📜 Transaction hash: ${transaction}
🔍 View in explorer: ${Const.TESTNET_EXPLORER.NILE_TRON}${transaction}`;
    return appendRequestId(message, requestId);
}

/**
 * Formats an error message for Tron transaction.
 * @param currency - The currency involved in the transaction.
 * @param error - The transaction details, including hash and error message.
 * @returns A formatted error message string.
 */
function formatErrorTronMultiSendTransaction(currency: string, error: any, requestId?: string): string {
    // Return a formatted error message
    const message = `❌ Type: Tron Multi Send Error
💸 Currency: ${currency}
❗ Error: ${error|| 'Unknown error'}`;
    return appendRequestId(message, requestId);
}

/**
 * Formats a success message for a standard Stellar transaction.
 * @param amount - The amount to transfer
 * @param addressSender - Address sender
 * @param currency - The currency involved in the transaction.
 * @param transaction - The transaction hash.
 * @returns A formatted success message string.
 */
function formatSuccessStellarTransaction(amount: string, addressSender: string, currency: string, transaction: string, requestId?: string): string {
    // Return a formatted success message
    const message = `⚙️ Type: Stellar transaction
⏰ Time: [${new Date().toLocaleString()}]
💰 Amount: ${amount}
💸 Currency: ${currency}
👤 Address sender: ${addressSender}
📜 Transaction hash: ${transaction}
🔍 View in explorer: ${Const.TESTNET_EXPLORER.STELLAR}${transaction}`;
    return appendRequestId(message, requestId);
}

/**
 * Formats an error message for Stellar transaction.
 * @param currency - The currency involved in the transaction.
 * @param error - The error description.
 * @returns A formatted error message string.
 */
function formatErrorStellar(currency: string, error: any, requestId?: string): string {
    // Return a formatted error message
    const message = `❌ Type: Stellar Error
💸 Currency: ${currency}
❗ Error: ${error || 'Unknown error'}`;
    return appendRequestId(message, requestId);
}

/**
 * Formats a success message for a Stellar multi send transaction.
 * @param currency - The currency involved in the transaction.
 * @param transaction - The transaction hash.
 * @returns A formatted success message string.
 */
function formatSuccessStellarMultiSendTransaction(currency: string, transaction: string, requestId?: string): string {
    // Return a formatted success message
    const message = `⚙️ Type: Stellar Multi Send Transaction
⏰ Time: [${new Date().toLocaleString()}]
💸 Currency: ${currency}
📜 Transaction hash: ${transaction}
🔍 View in explorer: ${Const.TESTNET_EXPLORER.STELLAR}${transaction}`;
    return appendRequestId(message, requestId);
}

/**
 * Formats an error message for a Stellar multi send transaction.
 * @param currency - The currency involved in the transaction.
 * @param error - The error description.
 * @returns A formatted error message string.
 */
function formatErrorStellarMultiSendTransaction(currency: string, error: any, requestId?: string): string {
    // Return a formatted error message
    const message = `❌ Type: Stellar Multi Send Error
💸 Currency: ${currency}
❗ Error: ${error || 'Unknown error'}`;
    return appendRequestId(message, requestId);
}

/**
 * Formats a success message for a standard Solana transaction.
 * @param account - The created token account
 * @param owner - The token account owner
 * @returns A formatted success message string.
 */
function formatSolanaCreateTokenAccount(account: string, owner: any, requestId?: string): string {
    // Return a formatted success message
    const message = `⚙️ Type: Solana Create Token Account
⏰ Time: [${new Date().toLocaleString()}]
️💂‍ Owner: ${owner}
🧪 Token Account: ${account}
🔍 View in explorer: ${Const.TESTNET_EXPLORER.SOLANA_ADDRESS}${account}?cluster=devnet`;
    return appendRequestId(message, requestId);
}

export const notifierMessage = {
    formatErrorEVM,
    formatErrorLTC,
    formatErrorTron,
    formatErrorSolana,
    formatErrorStellar,
    formatSuccessStellarTransaction,
    formatErrorStellarMultiSendTransaction,
    formatSuccessStellarMultiSendTransaction,
    formatErrorMultiSend,
    formatSuccessMultiSend,
    formatErrorMultiSendLTC,
    formatSuccessMultiSendLTC,
    formatSuccessEVMTransaction,
    formatSuccessLTCTransaction,
    formatSuccessTronTransaction,
    formatSuccessSolanaTransaction,
    formatSolanaCreateTokenAccount,
    formatSuccessSolanaMultiTransaction,
    formatErrorTronMultiSendTransaction,
    formatSuccessTronMultiSendTransaction
};
