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
import { requestIdRegistry } from '../utils/idempotency';
import { ApiError, toErrorResponse } from './errors';
import {
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

export function createApp(): Express {
    const app = express();

    /* Middleware to parse JSON request bodies */
    app.use(express.json());

    /* Liveness probe for Docker and the deploy job */
    app.get('/health', (_req: Request, res: Response) => {
        res.json({ status: 'ok', version, uptime_s: Math.round((Date.now() - startedAt) / 1000) });
    });

    /* Endpoint for processing single EVM payout transactions */
    app.post('/payout/evm', asyncRoute(async (req, res) => {
        const data = parseData(evmPayoutSchema, req.body);

        const txHash = await requestIdRegistry.run('payout/evm', data.request_id, req.body.data, async () => {
            const evmService = new PayoutService(data.payway, data.private_key);
            await evmService.init();
            return evmService.sendTransaction(
                data.payee_address,
                data.amount,
                data.contract as string,
                data.currency ?? '',
                data.wait_for_receipt ?? true,
                data.request_id
            );
        });
        res.json({ tx_id: txHash });
    }));

    /* Endpoint for processing multi-send EVM transactions */
    app.post('/payout/evm/multi_send', asyncRoute(async (req, res) => {
        const data = parseData(evmMultiSendSchema, req.body);

        const txHash = await requestIdRegistry.run('payout/evm/multi_send', data.request_id, req.body.data, async () => {
            const multiSendService = new MultiPayoutService(data.payway, data.private_key);
            await multiSendService.init(data.multi_send_contract);
            return multiSendService.multiSend(
                data.recipients,
                data.multi_send_contract,
                data.currency ?? '',
                data.wait_for_receipt ?? true,
                data.request_id
            );
        });
        res.json({ tx_id: txHash });
    }));

    /* Endpoint for processing batch send EVM transactions (native + multiple ERC20) */
    app.post('/payout/evm/batch_send', asyncRoute(async (req, res) => {
        const data = parseData(evmBatchSendSchema, req.body);

        const txHash = await requestIdRegistry.run('payout/evm/batch_send', data.request_id, req.body.data, async () => {
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
        res.json({ tx_id: txHash });
    }));

    /* Endpoint for native ETH L1->L2 bridge deposits (Sepolia -> Base/Arbitrum Sepolia) */
    app.post('/bridge/eth', asyncRoute(async (req, res) => {
        const data = parseData(bridgeSchema, req.body);

        const txHash = await requestIdRegistry.run('bridge/eth', data.request_id, req.body.data, async () => {
            const bridgeService = new EthBridgeService(data.private_key);
            await bridgeService.init();
            return bridgeService.deposit(
                data.destination as BridgeDestination,
                data.amount,
                data.payee_address,
                data.wait_for_receipt ?? true,
                data.request_id
            );
        });
        res.json({ tx_id: txHash });
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
        const txHash = await new LtcPayoutService().ltcSendTransaction(request);
        res.json({ tx_id: txHash });
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
        const txHash = await new LtcMultiPayoutService().ltcMultiSend(request);
        res.json({ tx_id: txHash });
    }));

    /* Endpoint for processing Solana transactions */
    app.post('/payout/solana', asyncRoute(async (req, res) => {
        const data = parseData(solanaPayoutSchema, req.body);

        const solanaService = new SolanaPayoutService(data.payway ?? 'sol', data.private_key);
        await solanaService.init();
        const txHash = await solanaService.sendTransaction(
            data.payee_address,
            data.amount,
            data.currency ?? '',
            data.token_mint as string,
            data.is_token_2022 ?? false
        );
        res.json({ tx_id: txHash });
    }));

    app.post('/payout/solana/multi_send', asyncRoute(async (req, res) => {
        const data = parseData(solanaMultiSendSchema, req.body);

        const multiService = new SolanaMultiPayoutService(data.private_key);
        await multiService.init();
        const txHash = await multiService.sendTransaction(data.recipients, data.currency ?? '', data.token_mint as string);
        res.json({ tx_id: txHash });
    }));

    /* Endpoint for processing Solana SPL transfers via an ephemeral intermediate ATA */
    app.post('/payout/solana/intermediate_ata', asyncRoute(async (req, res) => {
        const data = parseData(solanaIntermediateAtaSchema, req.body);

        const solanaService = new SolanaPayoutService(data.payway ?? 'sol', data.private_key);
        await solanaService.init();
        const txHash = await solanaService.sendWithIntermediateAta(
            data.payee_address,
            data.amount,
            data.token_mint,
            data.currency ?? '',
            data.is_token_2022 ?? false,
            data.request_id
        );
        res.json({ tx_id: txHash });
    }));

    /* Endpoint for create token account */
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

        const tronService = new TronPayoutService(payload.payway, payload.private_key);
        await tronService.init();
        const amount = await TronPayoutService.resolveTronAmount({ ...payload, currency }, tronService);
        const txHash = await tronService.sendTransaction(payload.payee_address, amount, payload.contract, currency);
        res.status(payload.isLegacy ? 201 : 200).json({ tx_id: txHash });
    }));

    app.post('/payout/tron/multi_send', asyncRoute(async (req, res) => {
        const data = parseData(tronMultiSendSchema, req.body);

        const tronMultiService = new TronMultiPayoutService(data.payway, data.private_key);
        await tronMultiService.init(data.multi_send_contract);
        const txHash = await tronMultiService.multiSend(data.token_contract, data.recipients, data.currency ?? '');
        res.json({ tx_id: txHash });
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
