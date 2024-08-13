/* External dependencies */
import * as fs from 'fs';
import * as path from 'path';

/* Internal dependencies */
import * as modules from '../utils/modules';

/* Service */
import { LtcPayoutService } from '../../services/ltc.payout.service';
import { LtcMultiPayoutService } from '../../services/ltc.multi-payout.service';

/* Interface */
import { LtcSinglePayoutRequest, LtcSinglePayoutRequestBody, LtcMultiPayoutRequest, LtcMultiPayoutRequestBody } from '../interfaces/ltc.payout.test.interface';

/* Constants */
import { ConstTest } from '../constants/const';

/**
 * Define the path to the test data and read the file.
 */
const testDataPath = path.resolve(__dirname, '../test-data/cryptoPaymentTestData.json');
const allTestData: (LtcSinglePayoutRequest | LtcMultiPayoutRequest)[] = JSON.parse(fs.readFileSync(testDataPath, 'utf-8'));

describe('Test LTC Transactions', () => {
    for (const testData of allTestData) {
        if (testData.tag === ConstTest.LTC) {
            it(testData.testName, async () => {
                let transactionHash: any;
                let service: LtcPayoutService | LtcMultiPayoutService;

                // Process based on method type
                if (testData.method === ConstTest.SINGLE) {
                    // Destructure relevant fields from request data
                    const {
                        method,
                        payee_address,
                        amount,
                        payway,
                        currency
                    } = testData.requestBody.data as LtcSinglePayoutRequestBody['data'];

                    // Initialize the LtcPayoutService
                    service = new LtcPayoutService();

                    // Send the transaction and retrieve the hash
                    transactionHash = await service.ltcSendTransaction({ method, payee_address, amount, payway, currency });;
                } else if (testData.method === ConstTest.MULTI) {
                    // Destructure relevant fields from request data
                    const {
                        method,
                        payway,
                        currency,
                        recipients,
                        comment,
                        minconf
                    } = testData.requestBody.data as LtcMultiPayoutRequestBody['data'];

                    // Initialize the LtcMultiPayoutService
                    service = new LtcMultiPayoutService();

                    // Send the transaction and retrieve the hash
                    transactionHash = await service.ltcMultiSend({ method, payway, currency, recipients, comment, minconf });
                } else {
                    throw new Error(`Unknown method type: ${testData.method}`);
                }

                // Log request details for debugging
                console.log('\x1b[1m\x1b[33mMethod:\x1b[0m', JSON.stringify(testData.method));
                console.log('\x1b[1m\x1b[33mRequest body:\x1b[0m', JSON.stringify(testData.requestBody.data));

                try {
                    // Log the response hash
                    console.log('\x1b[1m\x1b[33mResponse:\x1b[0m', JSON.stringify(transactionHash));

                    // Validate the format of the transaction hash
                    await modules.isValidLTCHash(transactionHash);

                    // Wait for the transaction to receive confirmations
                    await modules.waitForLtcConfirmations({
                        transactionHash,
                        requiredConfirmations: 1
                    });
                } catch (error) {
                    throw error;
                }
            });
        }
    }
});
