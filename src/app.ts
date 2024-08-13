/* External dependencies */
import express, { Request, Response } from 'express';

/* Service */
import { PayoutService } from './services/payout.service';
import { LtcPayoutService } from './services/ltc.payout.service';
import { MultiPayoutService } from './services/multi-payout.service';
import { LtcMultiPayoutService } from './services/ltc.multi-payout.service'

/* Interface */
import { PayoutRequestBody, MultiPayoutRequestBody } from './interfaces/payout.interface';
import { LtcPayoutRequestBody, LtcSendManyPayoutRequestBody } from './interfaces/ltc.payout.interface'

/* Setup express */
const app = express();
const port = process.env.PORT || 3000;

/* Middleware to parse JSON request bodies */
app.use(express.json());

/* Endpoint for processing single EVM payout transactions */
app.post('/payout/evm', async (req: Request, res: Response) => {
    // Destructure the request body to extract payout details
    const { payway, payee_address, amount, contract, currency, private_key }: PayoutRequestBody['data'] = req.body.data;

    // Initialize the PayoutService with the specified payment way and private key
    const evmService = new PayoutService(payway, private_key);
    await evmService.init();

    try {
        // Send the transaction and return the transaction hash
        const txHash = await evmService.sendTransaction(payee_address, amount, contract, currency);
        res.json({ tx_id: txHash });
    } catch (error) {
        // Handle errors and respond with a server error status
        res.status(500).json({ error: 'Server Error' });
    }
});

/* Endpoint for processing multi-send EVM transactions */
app.post('/payout/evm/multi_send', async (req: Request, res: Response) => {
    // Destructure the request body to extract multi-send payout details
    const { payway, recipients, private_key, currency, multi_send_contract }: MultiPayoutRequestBody['data'] = req.body.data;

    // Initialize the MultiPayoutService with the specified payment way and private key
    const multiSendService = new MultiPayoutService(payway, private_key);
    await multiSendService.init();

    try {
        // Execute the multi-send transaction and return the transaction hash
        const txHash = await multiSendService.multiSend(recipients, multi_send_contract, currency);
        res.json({ tx_id: txHash });
    } catch (error) {
        // Handle errors and respond with a server error status
        res.status(500).json({ error: 'Server Error' });
    }
});

/* Endpoint for processing single LTC payout transactions */
app.post('/payout/ltc', async (req: Request, res: Response) => {
    // Destructure the request body to extract payout details
    const { method, payee_address, amount, payway, currency }: LtcPayoutRequestBody['data'] = req.body.data;

    // Initialize the LtcPayoutService
    const ltcService = new LtcPayoutService();

    try {
        // Send the transaction and return the transaction hash
        const txHash = await ltcService.ltcSendTransaction({ method, payee_address, amount, payway, currency });
        res.json({ tx_id: txHash });
    } catch (error) {
        // Handle errors and respond with a server error status
        res.status(500).json({ error: 'Server Error' });
    }
});

/* Endpoint for processing multi-send LTC transactions */
app.post('/payout/ltc/multi_send', async (req: Request, res: Response) => {
    try {
        // Destructure the request body to extract payout details
        const { method, payway, currency, recipients, comment, minconf, account }: LtcSendManyPayoutRequestBody['data'] = req.body.data;

        // Initialize the LtcSendManyService
        const ltcSendManyService = new LtcMultiPayoutService();

        // Send the transaction and return the transaction hash
        const txHash = await ltcSendManyService.ltcMultiSend({ method, payway, currency, recipients, comment, minconf, account });
        res.json({ tx_id: txHash });
    } catch (error) {
        // Handle errors and respond with a server error status
        res.status(500).json({ error: 'Server Error' });
    }
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
