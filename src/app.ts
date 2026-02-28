process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

/* External dependencies */
import express, { Request, Response, NextFunction } from 'express';

/* Service imports */
import { PayoutService } from './services/payout.service';
import { LtcPayoutService } from './services/ltc.payout.service';
import { TronPayoutService } from './services/tron.payout.service';
import { MultiPayoutService } from './services/multi-payout.service';
import { SolanaPayoutService } from './services/solana.payout.service';
import { LtcMultiPayoutService } from './services/ltc.multi-payout.service';
import { EvmBatchPayoutService } from './services/evm.batch-payout.service';
import { TronMultiPayoutService } from './services/tron.multi-payout.service';

/* Interface imports */
import { SolanaPayoutRequestBody } from './interfaces/solana.payout.interface';
import { SolanaMultiPayoutService } from './services/solana.multi-payout.service';
import { LtcPayoutRequestBody, LtcSendManyPayoutRequestBody } from './interfaces/ltc.payout.interface';
import { MultiPayoutRequestBody, PayoutRequestBody, BatchPayoutRequestBody, TronCurrentPayoutData, TronLegacyPayoutRequestBody, TronNormalizedPayload } from './interfaces/payout.interface';

/* Setup express */
const app = express();
const port = process.env.PORT || 3000;

/* Middleware to parse JSON request bodies */
app.use(express.json());

/* Endpoint for processing single EVM payout transactions */
app.post('/payout/evm', async (req: Request, res: Response, next: NextFunction) => {
    // Destructure the request body to extract payout details
    const { payway, payee_address, amount, contract, currency, private_key }: PayoutRequestBody['data'] = req.body.data;

    // Initialize the PayoutService with the specified payment way and private key
    const evmService = new PayoutService(payway, private_key);

    try {
        await evmService.init();
        // Send the transaction and return the transaction hash
        const txHash = await evmService.sendTransaction(payee_address, amount, contract, currency);
        res.json({ tx_id: txHash });
    } catch (error) {
        // Pass the error to the global error handler
        next(error);
    }
});

/* Endpoint for processing multi-send EVM transactions */
app.post('/payout/evm/multi_send', async (req: Request, res: Response, next: NextFunction) => {
    // Destructure the request body to extract multi-send payout details
    const { payway, recipients, private_key, currency, multi_send_contract }: MultiPayoutRequestBody['data'] = req.body.data;

    // Initialize the MultiPayoutService with the specified payment way and private key
    const multiSendService = new MultiPayoutService(payway, private_key);

    try {
        await multiSendService.init(multi_send_contract);
        // Execute the multi-send transaction and return the transaction hash
        const txHash = await multiSendService.multiSend(recipients, multi_send_contract, currency);
        res.json({ tx_id: txHash });
    } catch (error) {
        // Pass the error to the global error handler
        next(error);
    }
});

/* Endpoint for processing batch send EVM transactions (native + multiple ERC20) */
app.post('/payout/evm/batch_send', async (req: Request, res: Response, next: NextFunction) => {
    const { payway, private_key, currency, batch_send_contract, native_transfers, token_transfers, request_id }: BatchPayoutRequestBody['data'] = req.body.data;

    const evmBatchService = new EvmBatchPayoutService(payway, private_key);

    try {
        await evmBatchService.init(batch_send_contract);
        const txHash = await evmBatchService.batchSend(native_transfers, token_transfers, currency, true, request_id);
        res.json({ tx_id: txHash });
    } catch (error) {
        next(error);
    }
});

/* Endpoint for processing single LTC payout transactions */
app.post('/payout/ltc', async (req: Request, res: Response, next: NextFunction) => {
    // Destructure the request body to extract payout details
    const { method, payee_address, amount, payway, currency }: LtcPayoutRequestBody['data'] = req.body.data;

    // Initialize the LtcPayoutService
    const ltcService = new LtcPayoutService();

    try {
        // Send the transaction and return the transaction hash
        const txHash = await ltcService.ltcSendTransaction({ method, payee_address, amount, payway, currency });
        res.json({ tx_id: txHash });
    } catch (error) {
        // Pass the error to the global error handler
        next(error);
    }
});

/* Endpoint for processing multi-send LTC transactions */
app.post('/payout/ltc/multi_send', async (req: Request, res: Response, next: NextFunction) => {
    try {
        // Destructure the request body to extract payout details
        const { method, payway, currency, recipients, comment, minconf, account }: LtcSendManyPayoutRequestBody['data'] = req.body.data;

        // Initialize the LtcSendManyService
        const ltcSendManyService = new LtcMultiPayoutService();

        // Send the transaction and return the transaction hash
        const txHash = await ltcSendManyService.ltcMultiSend({ method, payway, currency, recipients, comment, minconf, account });
        res.json({ tx_id: txHash });
    } catch (error) {
        // Pass the error to the global error handler
        next(error);
    }
});

/* Endpoint for processing Solana transactions */
app.post('/payout/solana', async (req: Request, res: Response, next: NextFunction) => {
    // Destructure the request body to extract payout details
    const { payway, private_key, currency, amount, payee_address, token_mint, is_token_2022 }: SolanaPayoutRequestBody['data'] = req.body.data;

    // Initialize the SolanaPayoutService
    const solanaService = new SolanaPayoutService(payway, private_key);

    try {
        await solanaService.init();

        // Send the transaction and return the transaction hash
        const txHash = await solanaService.sendTransaction(payee_address, amount, currency, token_mint, is_token_2022 || false);
        res.json({ tx_id: txHash });
    } catch (error) {
        // Pass the error to the global error handler
        next(error);
    }
});

app.post('/payout/solana/multi_send', async (req: Request, res: Response, next: NextFunction) => {
    // Destructure the request body to extract payout details
    const { private_key, currency, token_mint, recipients } = req.body.data;

    // Initialize the SolanaMultiPayoutService
    const multiService = new SolanaMultiPayoutService(private_key);

    try {
        await multiService.init();

        // Send the transaction and return the transaction hash
        const txHash = await multiService.sendTransaction(recipients, currency, token_mint);

        res.json({ tx_id: txHash });
    } catch (error) {
        // Pass the error to the global error handler
        next(error);
    }
});

/* Endpoint for create token account */
app.post('/solana/create_token_account', async (req: Request, res: Response, next: NextFunction) => {
    const { payway, private_key, token_mint, owner_address } = req.body.data;

    // Initialize the SolanaPayoutService
    const solanaService = new SolanaPayoutService(payway, private_key);

    try {
        await solanaService.init();

        // Create new token account
        const tokenAccountAddress = await solanaService.createNewTokenAccount(
            token_mint,
            owner_address
        );

        // Return token account
        res.json({ tokenAccount: tokenAccountAddress });
    } catch (error) {
        // Pass the error to the global error handler
        next(error);
    }
});

/* Endpoint for processing Tron transactions */
app.post('/payout/tron', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const payload = TronPayoutService.normalizeTronPayload(req.body);
        const { payway, private_key, currency, payee_address, contract } = payload;

        // Initialize the TronPayoutService
        const tronService = new TronPayoutService(payway, private_key);

        await tronService.init();
        const amount = await TronPayoutService.resolveTronAmount(payload, tronService);
        // Send the transaction and return the transaction hash
        const txHash = await tronService.sendTransaction(payee_address, amount, contract, currency);
        const statusCode = payload.isLegacy ? 201 : 200;
        res.status(statusCode).json({ tx_id: txHash });
    } catch (error) {
        // Pass the error to the global error handler
        next(error);
    }
});

app.post('/payout/tron/multi_send', async (req: Request, res: Response, next: NextFunction) => {
    // Destructure the request body to extract multi-send payout details
    const { payway, private_key, currency, multi_send_contract, recipients, token_contract } = (req.body as MultiPayoutRequestBody).data;

    // Initialize the TronMultiPayoutService with the specified payment way and private key
    const tronMultiService = new TronMultiPayoutService(payway, private_key);

    try {
        await tronMultiService.init(multi_send_contract);
        const txHash = await tronMultiService.multiSend(token_contract, recipients, currency);
        res.json({ tx_id: txHash });
    } catch (error) {
        next(error);
    }
});

/* Start the Express server */
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
