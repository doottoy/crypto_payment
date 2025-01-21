/* External dependencies */
import fetch from 'node-fetch';
import { config } from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { Connection, PublicKey } from '@solana/web3.js';

config();

/* Interface */
import { RpcResponse } from '../interfaces/ltc.payout.interface';

/* Constants */
import { Const } from '../constants/const';

/**
 * Sends a message to a specified Telegram chat using the Telegram Bot API.
 *
 * @param message - The message text to be sent to the Telegram chat.
 * @returns A Promise that resolves when the message has been sent.
 */
async function sendMessageToTelegram(message: string): Promise<void> {
    // Construct the URL for the Telegram Bot API
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

    // Configure the request options
    const options = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: message })
    };

    // Send the POST request to the Telegram API
    return (await fetch(url, options)).json();
}

/**
 * Retrieves the RPC URL based on the provided payway.
 *
 * @param payway - The payway identifier used to determine the appropriate RPC URL.
 * @returns A Promise that return  RPC URL corresponding to the given payway.
 */
async function getRpcUrl(payway: string): Promise<string> {
    return Const.BSC_PAYWAY.includes(payway)
        ? Const.BSC_TESTNET
        : Const.ARBITRUM_PAYWAY.includes(payway)
            ? Const.ARBITRUM_TESTNET
            : Const.BASE_PAYWAY.includes(payway)
                ? Const.BASE_TESTNET
                : Const.ETH_TESTNET;
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
export async function makeRpcRequest<T>(method: string, params: any[] = []): Promise<RpcResponse<T>> {
    // Ensure that the RPC URL is defined in environment variables.
    if (!process.env.RPC_URL || !process.env.RPC_USER || !process.env.RPC_PASS) {
        throw new Error('Credentials for RPC Auth is not defined in environment variables.');
    }

    try {
        // Perform the fetch request to the RPC URL with the provided method and parameters.
        const response = await fetch(process.env.RPC_URL, {
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

        // Parse and return the JSON response from the RPC server
        const data: RpcResponse<T> = await response.json();
        return data;
    } catch (error) {
        // Throw an error if the fetch operation fails or if any issue occurs
        throw new Error('Internal Server Error');
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

export const modules = {
    getRpcUrl,
    fetchDecimals,
    sendMessageToTelegram
};
