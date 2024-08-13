/* Internal dependencies */
import { modules, makeRpcRequest } from '../utils/modules';
import { notifierMessage } from '../utils/message-formatter';

/* Interface */
import { LtcBaseRequestBody } from '../interfaces/ltc.payout.interface';

/**
 * Service class for handling LTC payouts.
 */
export class LtcPayoutService {
    /**
     * Sends a transaction to the specified address with the given amount.
     *
     * @param request - The request body containing transaction details.
     * @returns A Promise that resolves with the transaction ID.
     */
    async ltcSendTransaction(request: LtcBaseRequestBody) {
        try {
            // Make the RPC request
            const response = await makeRpcRequest<{ result: string }>(request.method, [request.payee_address, request.amount]);

            // Log and notify about the successful transaction
            console.log(notifierMessage.formatSuccessLTCTransaction(request.payway, request.currency, response));
            await modules.sendMessageToTelegram(notifierMessage.formatSuccessLTCTransaction(request.payway, request.currency, response));

            // Return the transaction hash
            return response.result;
        } catch (error) {
            // Log and notify about the error in the transaction
            console.log(notifierMessage.formatErrorLTC(request.payway, request.currency, {}));
            await modules.sendMessageToTelegram(notifierMessage.formatErrorLTC(request.payway, request.currency, {}));
            // Rethrow error for further handling
            throw error;
        }
    }
}
