/* External dependencies */
import express, { Request, Response, NextFunction } from 'express';

/* Service imports */
import { PayoutService } from './services/payout.service';
import { LtcPayoutService } from './services/ltc.payout.service';
import { MultiPayoutService } from './services/multi-payout.service';
import { LtcMultiPayoutService } from './services/ltc.multi-payout.service';

/* Interface imports */
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

/* Start the Express server */
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

/* Global error handling middleware */
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    console.error(`Global error handler caught an error: ${err.stack || err}`);
    // Send a generic 500 error response
    res.status(500).json({ error: 'Server Error' });
});

/* Handle unhandled promise rejections */
process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

/* Handle uncaught exceptions */
process.on('uncaughtException', (err: Error) => {
    console.error('Uncaught Exception thrown:', err);
});
