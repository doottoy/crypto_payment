/* Internal dependencies */
import { modules, makeRpcRequest } from '../utils/modules';
import { notifierMessage } from '../utils/message-formatter';

/* Interface */
import { LtcSendManyRequestBody } from '../interfaces/ltc.payout.interface';

/**
 * Service class for handling LTC payouts with multiple addresses.
 */
export class LtcMultiPayoutService {
    /**
     * Sends multiple transactions to the specified addresses with the given amounts.
     *
     * @param request - The request body containing transaction details.
     * @returns A Promise that resolves with the transaction ID.
     */
    async ltcMultiSend(request: LtcSendManyRequestBody) {
        try {
            // Make the RPC request
            const response = await makeRpcRequest<{ result: string }>(request.method, [
                request.account,
                request.recipients,
                request.minconf,
                request.comment
            ]);

            // Log and notify about the successful transaction
            console.log(notifierMessage.formatSuccessMultiSendLTC(request.payway, request.currency, response));
            await modules.sendMessageToTelegram(notifierMessage.formatSuccessMultiSendLTC(request.payway, request.currency, response));

            // Return the transaction hash
            return response.result;
        } catch (error) {
            // Log and notify about the error in the transaction
            console.log(notifierMessage.formatErrorMultiSendLTC(request.payway, request.currency, {}));
            await modules.sendMessageToTelegram(notifierMessage.formatErrorMultiSendLTC(request.payway, request.currency, {}));
            throw error;
        }
    }
}
