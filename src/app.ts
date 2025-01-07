/* External dependencies */
import express, { Request, Response, NextFunction } from 'express';

/* Service imports */
import { PayoutService } from './services/payout.service';
import { LtcPayoutService } from './services/ltc.payout.service';
import { MultiPayoutService } from './services/multi-payout.service';
import { SolanaPayoutService } from './services/solana.payout.service';
import { LtcMultiPayoutService } from './services/ltc.multi-payout.service';

/* Interface imports */
import { SolanaPayoutRequestBody } from './interfaces/solana.payout.interface';
import { PayoutRequestBody, MultiPayoutRequestBody } from './interfaces/payout.interface';
import { LtcPayoutRequestBody, LtcSendManyPayoutRequestBody } from './interfaces/ltc.payout.interface';

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
        if (!currency) {
            return res.status(400).json({ error: 'Currency is required' });
        }

        // Send the transaction and return the transaction hash
        const txHash = await solanaService.sendTransaction(payee_address, amount,  currency, token_mint, is_token_2022 || false);
        res.json({ tx_id: txHash });
    } catch (error) {
        // Pass the error to the global error handler
        next(error);
    }
});

/* Start the Express server */
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
