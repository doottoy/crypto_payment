/* External dependencies */
import fetch from 'node-fetch';
import { config } from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { Connection, PublicKey } from '@solana/web3.js';

config();

/* Interface */
import { RpcResponse } from '../interfaces/ltc.payout.interface';

/* Internal dependencies */
import { logger } from './logger';
import { CoreRpcError } from '../api/errors';
import { notifierMessage } from './message-formatter';

/* Constants */
import { Const } from '../constants/const';
import { findEvmNetwork } from '../networks/evm-networks';

/**
 * Sends a message to a specified Telegram chat using the Telegram Bot API.
 *
 * @param message - The message text to be sent to the Telegram chat.
 * @returns A Promise that resolves when the message has been sent.
 */
async function sendMessageToTelegram(message: string): Promise<void> {
    // Without a bot configured (local runs, CI) there is nobody to notify
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
        return;
    }

    try {
        // Construct the URL for the Telegram Bot API
        const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

        // Configure the request options
        const options = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: message })
        };

        // Send the POST request to the Telegram API
        await fetch(url, options);
    } catch (error) {
        logger.warn('TELEGRAM', `Failed to send notification: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Retrieves the RPC URL based on the provided payway.
 *
 * @param payway - The payway identifier used to determine the appropriate RPC URL.
 * @returns A Promise that return  RPC URL corresponding to the given payway.
 */
async function getRpcUrl(payway: string): Promise<string> {
    // Anything that is not a known EVM payway falls back to Sepolia, as it always did
    return findEvmNetwork(payway)?.legacyRpcUrl ?? Const.ETH_TESTNET;
}

/**
 * Creates a Basic Authentication header.
 *
 * @param username - The username for authentication.
 * @param password - The password for authentication.
 * @returns The Basic Authentication header value.
 */
function createBasicAuthHeader(username: string, password: string): string {
    return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

/**
 * Sends an RPC request to the specified URL with the provided method and parameters.
 *
 * @param method - The RPC method to be called.
 * @param params - The parameters for the RPC method. Default is an empty array.
 * @returns A Promise that resolves to the response of the RPC request.
 * @throws Will throw an error if the RPC URL is not defined or if the fetch operation fails.
 */
export async function makeRpcRequest<T>(
    method: string,
    params: any[] = [],
    opts?: { wallet?: string }
): Promise<RpcResponse<T>> {
    if (!process.env.RPC_URL || !process.env.RPC_USER || !process.env.RPC_PASS) {
        throw new Error('Credentials for RPC Auth is not defined in environment variables');
    }

    const baseUrl = process.env.RPC_URL.replace(/\/+$/, '');
    const url = opts?.wallet ? `${baseUrl}/wallet/${encodeURIComponent(opts.wallet)}` : baseUrl;

    const response = await fetch(url, {
        method: Const.POST,
        headers: {
            'Content-Type': Const.APPLICATION_JSON,
            'Authorization': createBasicAuthHeader(process.env.RPC_USER, process.env.RPC_PASS)
        },
        body: JSON.stringify({
            method,
            params,
            id: uuidv4(),
            jsonrpc: Const.RPC
        })
    });

    // Errors come back as HTTP 500 with a JSON body; an auth failure (401) has no JSON at all
    const raw = await response.text();
    try {
        return JSON.parse(raw) as RpcResponse<T>;
    } catch {
        throw new CoreRpcError(method, undefined, `node answered HTTP ${response.status} without a JSON-RPC body`);
    }
}

/**
 * Fetches the decimals for a given SPL token mint.
 * @param connection - Connection (Solana RPC).
 * @param tokenMint - The mint address of the SPL token.
 * @returns The number of decimals.
 */
export async function fetchDecimals(connection: Connection, tokenMint: string): Promise<number> {
    const mintInfo = await connection.getParsedAccountInfo(new PublicKey(tokenMint));

    if (
        mintInfo.value &&
        mintInfo.value.data &&
        'parsed' in mintInfo.value.data &&
        'info' in mintInfo.value.data.parsed &&
        'decimals' in mintInfo.value.data.parsed.info
    ) {
        return mintInfo.value.data.parsed.info.decimals;
    } else {
        return 6;
    }
}

function getEvmRpcUrlsForPayway(payway: string): string[] {
    const network = findEvmNetwork(payway);
    if (!network) {
        throw new Error(`Unknown EVM payway: ${payway}`);
    }
    return Const.EVM_RPC_PROVIDERS[network.rpcKey];
}

/**
 * Unified EVM transaction logger for both single and multi-send transactions
 */
class EVMTransactionLogger {
    /**
     * Log successful EVM transaction
     */
    static async logSuccess(
        payway: string,
        currency: string,
        transactionHash: string,
        receipt: any,
        providerUrl: string,
        senderAddress?: string,
        duration?: number,
        isMultiSend: boolean = false,
        requestId?: string
    ): Promise<void> {
        const network = payway.toUpperCase();

        // Choose appropriate message formatter
        const successMsg = isMultiSend
            ? notifierMessage.formatSuccessMultiSend(payway, currency, receipt, requestId)
            : notifierMessage.formatSuccessEVMTransaction(payway, currency, {
                transactionHash,
                from: senderAddress || receipt.from
            }, requestId);

        // Log with duration if provided
        const durationInfo = duration ? `[MS:${duration}]` : '';
        const typeInfo = isMultiSend ? '[TYPE:multi]' : '[TYPE:single]';
        const reqInfo = requestId ? `[${requestId}]` : '';
        logger.info(network, `✅${reqInfo}[CONFIRMED][${providerUrl}]${durationInfo}${typeInfo}[HASH:${transactionHash}]`);

        await modules.sendMessageToTelegram(successMsg);
    }

    /**
     * Log EVM transaction error
     */
    static async logError(
        payway: string,
        currency: string,
        error: any,
        providerUrl: string,
        duration?: number,
        isMultiSend: boolean = false,
        requestId?: string
    ): Promise<void> {
        const network = payway.toUpperCase();
        const errorMessage = error?.message || error?.toString?.() || String(error);

        // Choose appropriate error formatter
        const errorMsg = isMultiSend
            ? notifierMessage.formatErrorMultiSend(payway, currency, errorMessage, requestId)
            : notifierMessage.formatErrorEVM(payway, currency, error, requestId);

        await modules.sendMessageToTelegram(errorMsg);

        const durationInfo = duration ? `[MS:${duration}]` : '';
        const typeInfo = isMultiSend ? '[TYPE:multi]' : '[TYPE:single]';
        const reqInfo = requestId ? `[${requestId}]` : '';
        logger.error(network, `❌${reqInfo}[ERROR][${providerUrl}]${durationInfo}${typeInfo}[MSG:${errorMessage}]`);
    }
}

export const modules = {
    getRpcUrl,
    fetchDecimals,
    sendMessageToTelegram,
    getEvmRpcUrlsForPayway,
    EVMTransactionLogger
};

// Export utility functions directly for use in services
export { getEvmRpcUrlsForPayway, EVMTransactionLogger };
