/* External dependencies */
import fs from 'fs';
import path from 'path';
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express';

/* Service imports */
import { PayoutService } from '../services/payout.service';
import { EthBridgeService } from '../services/eth-bridge.service';
import { LtcPayoutService } from '../services/ltc.payout.service';
import { TronPayoutService } from '../services/tron.payout.service';
import { MultiPayoutService } from '../services/multi-payout.service';
import { SolanaPayoutService } from '../services/solana.payout.service';
import { LtcMultiPayoutService } from '../services/ltc.multi-payout.service';
import { EvmBatchPayoutService } from '../services/evm.batch-payout.service';
import { TronMultiPayoutService } from '../services/tron.multi-payout.service';
import { SolanaMultiPayoutService } from '../services/solana.multi-payout.service';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { Const } from '../constants/const';
import { ApiError, toErrorResponse } from './errors';
import { getPayoutStore } from '../payouts/store';
import { toApiPayout } from '../payouts/serialize';
import { runPayout, type PayoutResult } from '../payouts/run';
import {
    flagOr,
    parseData,
    bridgeSchema,
    ltcPayoutSchema,
    evmPayoutSchema,
    tronPayoutSchema,
    ltcMultiSendSchema,
    evmMultiSendSchema,
    solanaPayoutSchema,
    evmBatchSendSchema,
    tronMultiSendSchema,
    payoutListQuerySchema,
    solanaMultiSendSchema,
    solanaIntermediateAtaSchema,
    solanaCreateTokenAccountSchema
} from './schemas';
import type { BridgeDestination } from '../interfaces/bridge.interface';
import type { LtcBaseRequestBody, LtcSendManyRequestBody } from '../interfaces/ltc.payout.interface';

const startedAt = Date.now();

function readVersion(): string {
    try {
        // dist/api/app.js and src/api/app.ts both sit two levels below the package root
        return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version;
    } catch {
        return 'unknown';
    }
}

const version = readVersion();

/**
 * Express 4 ignores the promise an async handler returns, so a throw outside a try left the request hanging forever.
 * Every route goes through this wrapper: any throw or rejection reaches the JSON error handler.
 */
export function asyncRoute(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
    return (req, res, next) => {
        handler(req, res).catch(next);
    };
}

/**
 * The body stays `{ tx_id }` as before; the journal ids travel in headers so existing clients see no change.
 */
function sendPayout(res: Response, result: PayoutResult, status = 200): void {
    res.setHeader('X-Payout-Id', result.payoutId);
    res.setHeader('X-Request-Id', result.requestId);
    if (result.replayed) res.setHeader('X-Idempotent-Replay', 'true');
    res.status(status).json({ tx_id: result.txId });
}

export function createApp(): Express {
    const app = express();

    /* Middleware to parse JSON request bodies */
    app.use(express.json());

    /* Liveness probe for Docker and the deploy job */
    app.get('/health', (_req: Request, res: Response) => {
        res.json({ status: 'ok', version, uptime_s: Math.round((Date.now() - startedAt) / 1000) });
    });

    /* Payout journal: one payout by its id or request_id */
    app.get('/payouts/:id', (req: Request, res: Response) => {
        const record = getPayoutStore().findLatest(req.params.id);
        if (!record) {
            throw new ApiError(404, 'payout_not_found', `No payout with id or request_id "${req.params.id}"`);
        }
        res.json(toApiPayout(record));
    });

    /* Payout journal: newest first, `before` = the `created_at` of the last item of the previous page */
    app.get('/payouts', (req: Request, res: Response) => {
        const query = payoutListQuerySchema.parse(req.query);
        const records = getPayoutStore().list({
            status: query.status,
            chain: query.chain,
            scope: query.endpoint,
            requestId: query.request_id,
            before: query.before,
            limit: query.limit
        });
        const limit = query.limit ?? 50;
        res.json({
            payouts: records.map(toApiPayout),
            next_before: records.length === limit ? records[records.length - 1].createdAt : null
        });
    });

    /* Endpoint for processing single EVM payout transactions */
    app.post('/payout/evm', asyncRoute(async (req, res) => {
        const data = parseData(evmPayoutSchema, req.body);
        const waitForReceipt = flagOr(data.wait_for_receipt, true);

        const result = await runPayout({
            scope: 'payout/evm',
            chain: 'evm',
            payway: data.payway,
            currency: data.currency,
            requestId: data.request_id,
            payload: req.body.data,
            callbackUrl: data.callback_url,
            settlesInBackground: !waitForReceipt
        }, async () => {
            const evmService = new PayoutService(data.payway, data.private_key);
            await evmService.init();
            return evmService.sendTransaction(
                data.payee_address,
                data.amount,
                data.contract as string,
                data.currency ?? '',
                waitForReceipt,
                data.request_id
            );
        });
        sendPayout(res, result);
    }));

    /* Endpoint for processing multi-send EVM transactions */
    app.post('/payout/evm/multi_send', asyncRoute(async (req, res) => {
        const data = parseData(evmMultiSendSchema, req.body);
        const waitForReceipt = flagOr(data.wait_for_receipt, true);

        const result = await runPayout({
            scope: 'payout/evm/multi_send',
            chain: 'evm',
            payway: data.payway,
            currency: data.currency,
            requestId: data.request_id,
            payload: req.body.data,
            callbackUrl: data.callback_url,
            settlesInBackground: !waitForReceipt
        }, async () => {
            const multiSendService = new MultiPayoutService(data.payway, data.private_key);
            await multiSendService.init(data.multi_send_contract);
            return multiSendService.multiSend(
                data.recipients,
                data.multi_send_contract,
                data.currency ?? '',
                waitForReceipt,
                data.request_id
            );
        });
        sendPayout(res, result);
    }));

    /* Endpoint for processing batch send EVM transactions (native + multiple ERC20) */
    app.post('/payout/evm/batch_send', asyncRoute(async (req, res) => {
        const data = parseData(evmBatchSendSchema, req.body);

        const result = await runPayout({
            scope: 'payout/evm/batch_send',
            chain: 'evm',
            payway: data.payway,
            currency: data.currency,
            requestId: data.request_id,
            payload: req.body.data,
            callbackUrl: data.callback_url
        }, async () => {
            const evmBatchService = new EvmBatchPayoutService(data.payway, data.private_key);
            await evmBatchService.init(data.batch_send_contract);
            return evmBatchService.batchSend(
                data.native_transfers ?? [],
                data.token_transfers ?? [],
                data.currency as string,
                true,
                data.request_id
            );
        });
        sendPayout(res, result);
    }));

    /* Endpoint for native ETH L1->L2 bridge deposits (Sepolia -> Base/Arbitrum Sepolia) */
    app.post('/bridge/eth', asyncRoute(async (req, res) => {
        // Checked first and worded as it always was, so clients matching this 400 keep working
        const rawDestination = req.body?.data?.destination;
        if (req.body?.data && typeof req.body.data === 'object'
            && !Const.BRIDGE_DESTINATIONS.includes(String(rawDestination ?? '').trim().toLowerCase())) {
            throw new ApiError(
                400,
                'invalid_request',
                `Unsupported bridge destination: ${rawDestination}. Supported: ${Const.BRIDGE_DESTINATIONS.join(', ')}`
            );
        }
        const data = parseData(bridgeSchema, req.body);
        const waitForReceipt = flagOr(data.wait_for_receipt, true);

        const result = await runPayout({
            scope: 'bridge/eth',
            chain: 'evm',
            payway: 'eth',
            currency: data.currency ?? 'ETH',
            requestId: data.request_id,
            payload: req.body.data,
            callbackUrl: data.callback_url,
            settlesInBackground: !waitForReceipt
        }, async () => {
            const bridgeService = new EthBridgeService(data.private_key);
            await bridgeService.init();
            return bridgeService.deposit(
                data.destination as BridgeDestination,
                data.amount,
                data.payee_address,
                waitForReceipt,
                data.request_id
            );
        });
        sendPayout(res, result);
    }));

    /* Endpoint for processing single LTC payout transactions */
    app.post('/payout/ltc', asyncRoute(async (req, res) => {
        const data = parseData(ltcPayoutSchema, req.body);
        const request: LtcBaseRequestBody = {
            method: 'sendtoaddress',
            payee_address: data.payee_address,
            amount: data.amount as unknown as number,
            payway: data.payway ?? 'ltc',
            currency: data.currency ?? 'LTC',
            request_id: data.request_id
        };

        const result = await runPayout({
            scope: 'payout/ltc',
            chain: 'ltc',
            payway: request.payway,
            currency: request.currency,
            requestId: data.request_id,
            payload: req.body.data,
            callbackUrl: data.callback_url
        }, () => new LtcPayoutService().ltcSendTransaction(request));
        sendPayout(res, result);
    }));

    /* Endpoint for processing multi-send LTC transactions */
    app.post('/payout/ltc/multi_send', asyncRoute(async (req, res) => {
        const data = parseData(ltcMultiSendSchema, req.body);
        const request: LtcSendManyRequestBody = {
            method: 'sendmany',
            payway: data.payway ?? 'ltc',
            currency: data.currency ?? 'LTC',
            recipients: data.recipients as LtcSendManyRequestBody['recipients'],
            comment: data.comment,
            minconf: data.minconf,
            account: data.account,
            request_id: data.request_id
        };

        const result = await runPayout({
            scope: 'payout/ltc/multi_send',
            chain: 'ltc',
            payway: request.payway,
            currency: request.currency,
            requestId: data.request_id,
            payload: req.body.data,
            callbackUrl: data.callback_url
        }, () => new LtcMultiPayoutService().ltcMultiSend(request));
        sendPayout(res, result);
    }));

    /* Endpoint for processing Solana transactions */
    app.post('/payout/solana', asyncRoute(async (req, res) => {
        const data = parseData(solanaPayoutSchema, req.body);
        const payway = data.payway ?? 'sol';

        const result = await runPayout({
            scope: 'payout/solana',
            chain: 'solana',
            payway,
            currency: data.currency,
            requestId: data.request_id,
            payload: req.body.data,
            callbackUrl: data.callback_url
        }, async () => {
            const solanaService = new SolanaPayoutService(payway, data.private_key);
            await solanaService.init();
            return solanaService.sendTransaction(
                data.payee_address,
                data.amount,
                data.currency ?? '',
                data.token_mint as string,
                flagOr(data.is_token_2022, false)
            );
        });
        sendPayout(res, result);
    }));

    app.post('/payout/solana/multi_send', asyncRoute(async (req, res) => {
        const data = parseData(solanaMultiSendSchema, req.body);

        const result = await runPayout({
            scope: 'payout/solana/multi_send',
            chain: 'solana',
            payway: 'sol',
            currency: data.currency,
            requestId: data.request_id,
            payload: req.body.data,
            callbackUrl: data.callback_url
        }, async () => {
            const multiService = new SolanaMultiPayoutService(data.private_key);
            await multiService.init();
            return multiService.sendTransaction(data.recipients, data.currency ?? '', data.token_mint as string);
        });
        sendPayout(res, result);
    }));

    /* Endpoint for processing Solana SPL transfers via an ephemeral intermediate ATA */
    app.post('/payout/solana/intermediate_ata', asyncRoute(async (req, res) => {
        const data = parseData(solanaIntermediateAtaSchema, req.body);
        const payway = data.payway ?? 'sol';

        const result = await runPayout({
            scope: 'payout/solana/intermediate_ata',
            chain: 'solana',
            payway,
            currency: data.currency,
            requestId: data.request_id,
            payload: req.body.data,
            callbackUrl: data.callback_url
        }, async () => {
            const solanaService = new SolanaPayoutService(payway, data.private_key);
            await solanaService.init();
            return solanaService.sendWithIntermediateAta(
                data.payee_address,
                data.amount,
                data.token_mint,
                data.currency ?? '',
                flagOr(data.is_token_2022, false),
                data.request_id
            );
        });
        sendPayout(res, result);
    }));

    /* Endpoint for create token account (not a payout, not journaled) */
    app.post('/solana/create_token_account', asyncRoute(async (req, res) => {
        const data = parseData(solanaCreateTokenAccountSchema, req.body);

        const solanaService = new SolanaPayoutService(data.payway ?? 'sol', data.private_key);
        await solanaService.init();
        const tokenAccountAddress = await solanaService.createNewTokenAccount(data.token_mint, data.owner_address);
        res.json({ tokenAccount: tokenAccountAddress });
    }));

    /* Endpoint for processing Tron transactions (current `{ data }` shape and the legacy flat shape) */
    app.post('/payout/tron', asyncRoute(async (req, res) => {
        let normalized;
        try {
            normalized = TronPayoutService.normalizeTronPayload(req.body);
        } catch (error) {
            throw new ApiError(400, 'invalid_request', error instanceof Error ? error.message : String(error));
        }
        const payload = tronPayoutSchema.parse(normalized);
        const currency = payload.currency ?? (payload.contract ? '' : 'TRX');

        const result = await runPayout({
            scope: 'payout/tron',
            chain: 'tron',
            payway: payload.payway,
            currency,
            requestId: payload.request_id,
            payload: normalized,
            callbackUrl: payload.callback_url
        }, async () => {
            const tronService = new TronPayoutService(payload.payway, payload.private_key);
            await tronService.init();
            const amount = await TronPayoutService.resolveTronAmount({ ...payload, currency }, tronService);
            return tronService.sendTransaction(payload.payee_address, amount, payload.contract, currency, payload.request_id);
        });
        sendPayout(res, result, payload.isLegacy ? 201 : 200);
    }));

    app.post('/payout/tron/multi_send', asyncRoute(async (req, res) => {
        const data = parseData(tronMultiSendSchema, req.body);

        const result = await runPayout({
            scope: 'payout/tron/multi_send',
            chain: 'tron',
            payway: data.payway,
            currency: data.currency,
            requestId: data.request_id,
            payload: req.body.data,
            callbackUrl: data.callback_url
        }, async () => {
            const tronMultiService = new TronMultiPayoutService(data.payway, data.private_key);
            await tronMultiService.init(data.multi_send_contract);
            return tronMultiService.multiSend(data.token_contract, data.recipients, data.currency ?? '', data.request_id);
        });
        sendPayout(res, result);
    }));

    /* Unknown routes answer JSON too */
    app.use((req: Request, res: Response) => {
        res.status(404).json({ error: `No route for ${req.method} ${req.path}`, code: 'not_found' });
    });

    /* Every error ends here: JSON with a code, never an HTML page with a stack trace */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
        if (res.headersSent) {
            next(err);
            return;
        }

        const { status, body } = toErrorResponse(err);
        const line = `[${req.method} ${req.path}][${status}][${body.code}][MSG:${body.error}]`;
        if (status >= 500) {
            logger.error('API', `❌${line}`);
        } else {
            logger.warn('API', `⚠️${line}`);
        }
        res.status(status).json(body);
    });

    return app;
}
