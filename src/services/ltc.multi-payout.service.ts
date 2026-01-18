/* Internal dependencies */
import { logger } from '../utils/logger';
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
        const network = request.payway.toUpperCase();
        const reqInfo = request.request_id ? `[${request.request_id}]` : '';
        try {
            const amounts: Record<string, number> = {};

            const isArray = Array.isArray((request as any).recipients);
            if (isArray) {
                const list = (request as any).recipients as Array<{ address: string; amount: number | string }>;
                for (let i = 0; i < list.length; i++) {
                    const r = list[i];
                    const v = typeof r.amount === 'string' ? parseFloat(r.amount) : r.amount;
                    if (!globalThis.Number.isFinite(v) || v <= 0) {
                        throw new Error(`Invalid amount for ${r.address}: ${r.amount}`);
                    }
                    amounts[r.address] = v;
                }
            } else {
                const map = (request as any).recipients as Record<string, number | string>;
                for (const addr in map) {
                    if (!Object.prototype.hasOwnProperty.call(map, addr)) continue;
                    const raw = map[addr];
                    const v = typeof raw === 'string' ? parseFloat(raw) : raw;
                    if (!globalThis.Number.isFinite(v) || v <= 0) {
                        throw new Error(`Invalid amount for ${addr}: ${String(raw)}`);
                    }
                    amounts[addr] = v;
                }
            }

            const keys = Object.keys(amounts);
            const subtractFrom: string[] = keys.length ? [keys[keys.length - 1]] : [];

            const rpc = await makeRpcRequest<{ result: string }>(
                'sendmany',
                [
                    "",
                    amounts,
                    request.minconf ?? 1,
                    request.comment ?? "",
                    subtractFrom
                ],
                (request as any).account ? { wallet: (request as any).account } : undefined
            );

            logger.info(network, `🔄${reqInfo}[MULTISEND][RECIPIENTS:${Object.keys(amounts).length}]`);

            if ((rpc as any).error) {
                logger.error(network, `❌${reqInfo}[MULTISEND_ERROR][MSG:${JSON.stringify((rpc as any).error)}]`);
                await modules.sendMessageToTelegram(
                    notifierMessage.formatErrorMultiSendLTC(
                        request.payway,
                        request.currency,
                        (rpc as any).error,
                        request.request_id
                    )
                );
                throw new Error(JSON.stringify((rpc as any).error));
            }

            const successMsg = notifierMessage.formatSuccessMultiSendLTC(
                request.payway,
                request.currency,
                rpc,
                request.request_id
            );
            logger.info(network, `✅${reqInfo}[MULTISEND_CONFIRMED][HASH:${rpc.result}]`);
            await modules.sendMessageToTelegram(
                successMsg
            );

            return rpc.result;
        } catch (error) {
            const errorMsg = notifierMessage.formatErrorMultiSendLTC(
                request.payway,
                request.currency,
                error,
                request.request_id
            );
            const errMsg = error instanceof Error ? error.message : String(error);
            logger.error(network, `❌${reqInfo}[ERROR][MSG:${errMsg}]`);
            await modules.sendMessageToTelegram(
                errorMsg
            );
            throw error;
        }
    }
}
