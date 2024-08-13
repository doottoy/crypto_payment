/* External dependencies */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

/* Internal dependencies */
import * as modules from '../utils/modules';

/* Service */
import { PayoutService } from '../../services/payout.service';
import { MultiPayoutService } from '../../services/multi-payout.service';

/* Interface */
import { SinglePayoutRequest, SinglePayoutRequestBody, MultiPayoutRequest, MultiPayoutRequestBody } from '../interfaces/payout.service.test.interface';

/* Constants */
import { ConstTest } from '../constants/const';

/**
 * Define the path to the test data and read the file.
 */
const testDataPath = path.resolve(__dirname, '../test-data/cryptoPaymentTestData.json');
const allTestData: (SinglePayoutRequest | MultiPayoutRequest)[] = JSON.parse(fs.readFileSync(testDataPath, 'utf-8'));

describe('Test EVM Transactions', () => {
    for (const testData of allTestData) {
        if (ConstTest.EVM_PAYWAY.includes(testData.tag)) {
            it(testData.testName, async () => {
                let transactionHash: string;
                let service: PayoutService | MultiPayoutService;

                // Check if private_key needs to be updated
                if (await modules.doesObjHasValue(testData.requestBody.data, ConstTest.PRIVATE_KEY)) {
                    if (process.env.AUTOMATION_EVM_PRIVATE_KEY === undefined) {
                        throw new Error('AUTOMATION_EVM_PRIVATE_KEY is not defined.');
                    }
                    await modules.updateObjValue(testData.requestBody.data, ConstTest.PRIVATE_KEY, process.env.AUTOMATION_EVM_PRIVATE_KEY);
                }

                // Process based on method type
                if (testData.method === ConstTest.SINGLE) {
                    // Destructure relevant fields from request data
                    const {
                        payway,
                        currency,
                        amount,
                        payee_address,
                        private_key,
                        contract
                    } = testData.requestBody.data as SinglePayoutRequestBody['data'];

                    // Initialize the PayoutService with necessary parameters
                    service = new PayoutService(payway, private_key);
                    await service.init();

                    // Send the transaction and retrieve the hash
                    transactionHash = await service.sendTransaction(payee_address, amount, contract, currency);
                } else if (testData.method === ConstTest.MULTI) {
                    // Destructure relevant fields from request data
                    const {
                        payway,
                        private_key,
                        multi_send_contract,
                        recipients
                    } = testData.requestBody.data as MultiPayoutRequestBody['data'];

                    // Initialize the MultiPayoutService with necessary parameters
                    service = new MultiPayoutService(payway, private_key);
                    await service.init();

                    // @ts-ignore
                    // Send the transaction and retrieve the hash
                    transactionHash = await service.multiSend(recipients, multi_send_contract);
                } else {
                    throw new Error(`Unknown method type: ${testData.method}`);
                }

                // Log request details for debugging
                const sanitizedData = await modules.sanitizeRequestData(testData.requestBody.data);
                console.log('\x1b[1m\x1b[33mMethod:\x1b[0m', JSON.stringify(testData.method));
                console.log('\x1b[1m\x1b[33mRequest body:\x1b[0m', JSON.stringify(sanitizedData));

                try {
                    // Log the response hash
                    console.log('\x1b[1m\x1b[33mResponse:\x1b[0m', JSON.stringify(transactionHash));

                    // Validate the format of the transaction hash
                    await modules.isValidEVMHash(transactionHash);

                    // Wait for the transaction to receive confirmations
                    await modules.waitForConfirmations({
                        providerUrl: await modules.getRpcUrl(testData.requestBody.data.payway),
                        transactionHash,
                        requiredConfirmations: ConstTest.CONFIRMATION,
                        expectedContract: testData.method === ConstTest.SINGLE
                            ? (testData.requestBody.data as SinglePayoutRequestBody['data']).contract
                            : (testData.requestBody.data as MultiPayoutRequestBody['data']).multi_send_contract
                    });

                    // Close the service after successful transaction
                    await modules.closeService({
                        provider: service.getProvider()
                    });
                } catch (error) {
                    // Close service on failure
                    await modules.closeService({
                        provider: service.getProvider()
                    });

                    throw error;
                }
            });
        }
    }
});
