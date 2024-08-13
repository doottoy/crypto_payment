/* External dependencies */
import Web3 from 'web3';
import { config } from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

config();

/* Internal dependencies */
import { BaseRequestData } from '../interfaces/payout.service.test.interface'
import { ClosableProvider, WaitForConfirmationsParams, WaitForLtcConfirmationsParams } from '../interfaces/modules.interface'

/* Constants */
import { Const } from '../../constants/const'
import { ConstTest } from '../constants/const';

/**
 * Checks if a given item is a valid JSON object.
 *
 * @param item - The item to be checked. Can be a string, object, or any other type.
 * @returns `true` if the item is a valid JSON object; otherwise, `false`.
 */
function isJson(item: any): boolean {
    // Convert the item to a JSON string if it is not already a string
    item = typeof item !== 'string'
        ? JSON.stringify(item)
        : item;

    try {
        item = JSON.parse(item);
    } catch {
        return false;
    }

    // Return true if the parsed item is a non-null object
    return typeof item === 'object' && item !== null;
}

/**
 * Stops the provider engine of the given service, if it has one.
 *
 * @param service - The service object that may include a `getProvider` method
 * @returns A promise that resolves once the provider's engine has been stopped
 */
async function closeService(service: ClosableProvider): Promise<void> {
    const provider = service.provider;
    if (provider?.engine) {
        provider.engine.stop();
    }
}

/**
 * Checks if a specified value exists in the given object or its nested `data` property.
 *
 * @param obj - The object to search within. It can be any object with an optional `data` property.
 * @param expValue - The value to search for within the object.
 * @returns `true` if the value exists in the object or its `data` property; otherwise, `false`.
 */
async function doesObjHasValue(obj: any, expValue: string | number): Promise<boolean> {
    /**
     * Recursively checks if a specified value exists in the object asynchronously.
     *
     * @param obj - The object in which to search for the value.
     * @param expValue - The value to search for within the object.
     * @returns A promise that resolves to true if the value exists in the object; otherwise, false.
     */
    async function doesValueExistInObjRoot(obj: Record<string, any>, expValue: string | number): Promise<boolean> {
        for (const key in obj) {
            if (typeof obj[key] === 'object' && obj[key] !== null) {
                // Recursively check nested objects
                if (await doesValueExistInObjRoot(obj[key], expValue)) {
                    return true;
                }
            } else if (obj[key] === expValue) {
                return true;
            }
        }
        return false;
    }

    // Check if the value exists in the root object
    let valueExistsInRoot = await doesValueExistInObjRoot(obj, expValue);

    // If not found at root level, check the `data` property if it exists
    if (!valueExistsInRoot && obj.data) {
        valueExistsInRoot = await doesValueExistInObjRoot(obj.data, expValue);
    }

    return valueExistsInRoot;
}

// @ts-ignore
/**
 * Updates all occurrences of a specified value in the given object and its nested `data` property.
 *
 * @param obj - The object in which to search and update the value. It can be any object with an optional `data` property.
 * @param oldValue - The value to be replaced in the object.
 * @param newValue - The new value to replace the old value with.
 * @param hasBeenUpdated - Internal flag used to track if any updates have been made. Defaults to `false`.
 * @throws {Error} - Throws an error if the `oldValue` is not found in the object.
 */
async function updateObjValue(
    obj: any,
    oldValue: string | number,
    newValue: string | number,
    hasBeenUpdated: boolean = false
): Promise<void> {
    if (!await doesObjHasValue(obj, oldValue)) {
        throw new Error(`Value "${oldValue}" is absent in the object - it is impossible to update it.`);
    }

    // Iterate over the entries of the object.
    for (const [key, value] of Object.entries(obj)) {
        if (value === oldValue) {
            obj[key] = newValue;
            hasBeenUpdated = true;
        }
    }

    // If no update was made at the root level, check the `data` property if it exists.
    if (!hasBeenUpdated && obj.data) {
        await updateObjValue(obj.data, oldValue, newValue, true);  // Добавляем await
    }
}

/**
 * Sanitizes the request data by replacing sensitive values
 *
 * @param data - The request data object to be sanitized.
 * @returns - The sanitized request data object.
 */
async function sanitizeRequestData(data: BaseRequestData): Promise<BaseRequestData> {
    return new Promise((resolve) => {
        resolve({
            ...data,
            private_key: ConstTest.CHANGED
        });
    });
}

/**
 * Validates if the given hash is a valid EVM hash or address.
 *
 * @param hash - The hash to be validated.
 * @returns A promise that resolves to `true` if the hash is valid, or `false` otherwise.
 * @throws {Error} - Throws an error if the hash is invalid.
 */
async function isValidEVMHash(hash: string): Promise<void> {
    const regex = /^0x[a-fA-F0-9]{40,64}$/;

    if (!regex.test(hash)) {
        throw Error(`Invalid EVM hash - ${hash}`);
    } else {
        console.log(`EVM hash - ${hash} successful validation`)
    }
}

/**
 * Validates if the given hash is a valid LTC transaction ID.
 *
 * @param hash - The hash to be validated.
 * @returns A promise that resolves to `true` if the hash is valid, or `false` otherwise.
 * @throws {Error} - Throws an error if the hash is invalid.
 */
async function isValidLTCHash(hash: string): Promise<void> {
    const regex = /^[a-fA-F0-9]{64}$/;

    if (!regex.test(hash)) {
        throw new Error(`Invalid LTC transaction hash - ${hash}`);
    } else {
        console.log(`LTC transaction hash - ${hash} successful validation`);
    }
}

/**
 * Waits for a transaction to receive a specified number of confirmations and validates additional transaction details.
 *
 * @param providerUrl - URL of the Ethereum provider.
 * @param transactionHash - The hash of the transaction to monitor.
 * @param requiredConfirmations - The number of confirmations required.
 * @param expectedRecipient - The expected recipient address for the transaction.
 * @param expectedContract - The expected contract address (optional).
 * @param maxRetries - The maximum number of retries before throwing an error (default is 50).
 * @param sleepDuration - The duration to wait between retries in milliseconds (default is 5000).
 * @returns A promise that resolves when the required number of confirmations is reached and additional checks pass.
 * @throws Error if the transaction does not receive the required number of confirmations within the maximum number of retries, or if the additional checks fail.
 */
async function waitForConfirmations({
    providerUrl,
    transactionHash,
    requiredConfirmations,
    expectedContract,
    maxRetries = 100,
    sleepDuration = 5000
}: WaitForConfirmationsParams): Promise<void> {
    const web3 = new Web3(new Web3.providers.HttpProvider(providerUrl));
    let retries = maxRetries;

    while (retries > 0) {
        try {
            // Fetch the transaction receipt
            const receipt = await web3.eth.getTransactionReceipt(transactionHash);

            if (receipt === null) {
                // Transaction is not yet mined
                console.log(`Transaction ${transactionHash} is not yet mined.`);
            } else {
                // Transaction is mined, calculate confirmations
                const currentBlock = await web3.eth.getBlockNumber();
                const transactionBlock = receipt.blockNumber;
                const confirmations = currentBlock - transactionBlock + 1;

                console.log(`Transaction ${transactionHash} expect ${confirmations} confirmations, actual = ${requiredConfirmations}, block ${currentBlock}`);

                if (confirmations >= requiredConfirmations) {
                    // Fetch the transaction details
                    const transaction = await web3.eth.getTransaction(transactionHash);

                    if (transaction) {
                        // Validate recipient address and amount
                        const contractValid = expectedContract ? transaction.to?.toLowerCase() === expectedContract.toLowerCase() : true;

                        // Log the details being checked
                        console.log(`Expected contract = ${expectedContract}, actual contract = ${transaction.to}`);

                        if (contractValid) {
                            console.log(`Transaction ${transactionHash} has received the required number of confirmations and additional details are valid`);
                            return;
                        } else {
                            throw new Error(`Transaction ${transactionHash} has incorrect details: contractValid = ${contractValid}`);
                        }
                    } else {
                        throw new Error(`Transaction ${transactionHash} details could not be fetched`);
                    }
                }
            }

            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, sleepDuration));
            retries -= 1;

        } catch (error) {
            console.error(`Error while checking transaction details: ${error}`);
        }
    }

    throw new Error(`Transaction ${transactionHash} did not receive the required ${requiredConfirmations} confirmations within the given retries`);
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
 * Waits for a Litecoin transaction to receive the required number of confirmations.
 *
 * @param transactionHash - The hash of the transaction to monitor.
 * @param requiredConfirmations - The number of confirmations required for the transaction to be considered final.
 * @param maxRetries - Optional, the maximum number of retries before throwing an error. Defaults to 100.
 * @param sleepDuration - Optional, the duration (in milliseconds) to wait between retries. Defaults to 5000 ms.
 * @throws Error if the transaction does not receive the required number of confirmations within the maximum number of retries.
 */
async function waitForLtcConfirmations({
    transactionHash,
    requiredConfirmations,
    maxRetries = 150,
    sleepDuration = 5000
}: WaitForLtcConfirmationsParams): Promise<void> {
    // Ensure that the RPC URL is defined in environment variables.
    if (!process.env.RPC_URL || !process.env.RPC_USER || !process.env.RPC_PASS) {
        throw new Error('Credentials for RPC Auth is not defined in environment variables');
    }

    // Helper function to handle retries and waiting
    const retryWithDelay = async () => {
        await new Promise(resolve => setTimeout(resolve, sleepDuration));
        maxRetries -= 1;
    };

    while (maxRetries > 0) {
        try {
            const response = await fetch(process.env.RPC_URL, {
                method: ConstTest.POST,
                headers: {
                    'Authorization': createBasicAuthHeader(process.env.RPC_USER, process.env.RPC_PASS),
                    'Content-Type': ConstTest.APPLICATION_JSON
                },
                body: JSON.stringify({
                    method: ConstTest.RPC_METHOD.GET_RAW_TRANSACTION,
                    params: [transactionHash, true],
                    id: uuidv4()
                })
            });

            const { result } = await response.json();

            if (result) {
                console.log(`Transaction ${transactionHash} expect ${requiredConfirmations} confirmations, actual = ${result.confirmations}, locktime ${result.locktime}`);

                if (result.confirmations >= requiredConfirmations) {
                    console.log(`Transaction ${transactionHash} has received the required number of confirmations`);
                    return;
                }
            } else {
                console.log(`Transaction ${transactionHash} details not available yet`);
            }

            // Wait before retrying
            await retryWithDelay();

        } catch (error) {
            console.error(`Error checking transaction: ${error}`);
            // Wait before retrying
            await retryWithDelay();
        }
    }

    throw new Error(`Transaction ${transactionHash} did not receive ${requiredConfirmations} confirmations within the maximum retries`);
}

export {
    isJson,
    getRpcUrl,
    closeService,
    updateObjValue,
    isValidEVMHash,
    isValidLTCHash,
    doesObjHasValue,
    sanitizeRequestData,
    waitForConfirmations,
    waitForLtcConfirmations
};
