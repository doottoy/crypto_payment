/* Internal dependencies */
import { logger } from '../utils/logger';
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
        const network = request.payway.toUpperCase();
        const reqInfo = request.request_id ? `[${request.request_id}]` : '';
        try {
            logger.info(network, `🔄${reqInfo}[SEND][AMOUNT:${request.amount}][CUR:${request.currency}][TO:${request.payee_address}]`);

            // Make the RPC request
            const response = await makeRpcRequest<{ result: string }>(request.method, [request.payee_address, request.amount]);

            // Log and notify about the successful transaction
            const successMsg = notifierMessage.formatSuccessLTCTransaction(
                request.payway,
                request.currency,
                response,
                request.request_id
            );
            logger.info(network, `✅${reqInfo}[CONFIRMED][HASH:${response.result}]`);
            await modules.sendMessageToTelegram(successMsg);

            // Return the transaction hash
            return response.result;
        } catch (error) {
            // Log and notify about the error in the transaction
            const errorMsg = notifierMessage.formatErrorLTC(request.payway, request.currency, error, request.request_id);
            const errMsg = error instanceof Error ? error.message : String(error);
            logger.error(network, `❌${reqInfo}[ERROR][MSG:${errMsg}]`);
            await modules.sendMessageToTelegram(errorMsg);
            // Rethrow error for further handling
            throw error;
        }
    }
}
