/* External dependencies */
import bs58 from 'bs58';

import {
    Keypair,
    PublicKey,
    Connection,
    Transaction,
    SystemProgram,
    sendAndConfirmTransaction
} from '@solana/web3.js';

import {
    TOKEN_2022_PROGRAM_ID,
    createTransferInstruction,
    getOrCreateAssociatedTokenAccount
} from '@solana/spl-token';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { modules, fetchDecimals } from '../utils/modules';
import { Recipient } from '../interfaces/payout.interface';
import { notifierMessage } from '../utils/message-formatter';
import { formatSolanaError } from '../utils/solana-error-handler';

/* Constants */
import { Const } from '../constants/const';

/**
 * Service class for handling Solana multisend transactions (native SOL or SPL-token).
 */
export class SolanaMultiPayoutService {
    private connection: Connection;
    private payer!: Keypair;
    private readonly network = 'SOLANA_MULTI';

    /**
     * @param privateKey - Base58-encoded private key (32 or 64 bytes)
     */
    constructor(private privateKey: string) {
        const endpoint = Const.SOLANA_DEVNET;
        this.connection = new Connection(endpoint, 'confirmed');
    }

    /**
     * Initializes the Keypair from the provided base58-encoded private key.
     */
    public async init(): Promise<void> {
        const decoded = bs58.decode(this.privateKey);
        if (decoded.length === 64) {
            this.payer = Keypair.fromSecretKey(decoded);
        } else if (decoded.length === 32) {
            this.payer = Keypair.fromSeed(decoded);
        } else {
            throw new Error(`Bad secret key size: ${decoded.length}, expected 32 or 64`);
        }
    }

    /**
     * Sends multiple transactions in a single transaction.
     *
     * @param recipients - An array of Recipient objects (with address and amount)
     * @param currency - A currency identifier for notifications/logging
     * @param tokenMint - If provided, treat this as an SPL-token multi-transfer
     * @returns The transaction signature (hash) once confirmed
     */
    public async sendTransaction(
        recipients: Recipient[],
        currency: string,
        tokenMint?: string
    ): Promise<string> {
        try {
            // If no tokenMint, treat as native SOL
            if (!tokenMint) {
                return await this.sendMultipleNativeSOL(recipients, currency);
            } else {
                // Otherwise, SPL-token
                return await this.sendMultipleSPLToken(recipients, tokenMint, currency);
            }
        } catch (error) {
            // Handle and format the error
            const formattedError = formatSolanaError(error);
            logger.error(this.network, `❌ Solana multisend error: ${formattedError}`);

            await modules.sendMessageToTelegram(notifierMessage.formatErrorSolana(currency, formattedError));
            throw new Error(formattedError);
        }
    }

    /**
     * Sends multiple SOL transactions in a single transaction.
     *
     * @param recipients - Array of recipients, each containing a Base58 address and amount in SOL
     * @param currency - Used for notifications/logging
     * @returns Transaction signature (hash)
     */
    private async sendMultipleNativeSOL(
        recipients: Recipient[],
        currency: string
    ): Promise<string> {
        try {
            // Create a new transaction
            const tx = new Transaction();
            logger.info(this.network, `✍️ Multisend SOL to ${recipients.length} recipients`);

            // For each recipient, add a SystemProgram.transfer instruction
            for (const r of recipients) {
                const lamports = Math.floor(parseFloat(r.amount) * 1e9);
                tx.add(
                    SystemProgram.transfer({
                        fromPubkey: this.payer.publicKey,
                        toPubkey: new PublicKey(r.address),
                        lamports
                    })
                );
            }

            // Send the transaction
            const signature = await sendAndConfirmTransaction(this.connection, tx, [this.payer]);

            // Log and notify about the successful transaction
            const successMsg = notifierMessage.formatSuccessSolanaMultiTransaction(currency, signature, this.payer.publicKey.toBase58());
            logger.info(this.network, successMsg);
            await modules.sendMessageToTelegram(successMsg);

            return signature;
        } catch (error) {
            throw error;
        }
    }

    /**
     * Sends multiple SPL transactions in a single transaction.
     *
     * @param recipients - Array of recipients, each with address and amount
     * @param tokenMint - The mint address of the SPL-token
     * @param currency - For notifications/logging
     * @returns Transaction signature (hash)
     */
    private async sendMultipleSPLToken(
        recipients: Recipient[],
        tokenMint: string,
        currency: string
    ): Promise<string> {
        try {
            // Determine correct token program
            const mintPubkey = new PublicKey(tokenMint);
            const tokenProgramId = TOKEN_2022_PROGRAM_ID;
            logger.info(this.network, `✍️ Multisend SPL token ${tokenMint} to ${recipients.length} recipients`);

            // Create/find ATA for the sender
            const senderAta = await getOrCreateAssociatedTokenAccount(
                this.connection,
                this.payer,
                mintPubkey,
                this.payer.publicKey,
                false,
                undefined,
                undefined,
                tokenProgramId
            );

            // Fetch token decimals from chain
            const decimals = await fetchDecimals(this.connection, tokenMint);

            // Create a single transaction with multiple instructions
            const tx = new Transaction();

            for (const r of recipients) {
                const payeePubkey = new PublicKey(r.address);

                // Create/find ATA for each recipient
                const recipientAta = await getOrCreateAssociatedTokenAccount(
                    this.connection,
                    this.payer,
                    mintPubkey,
                    payeePubkey,
                    false,
                    undefined,
                    undefined,
                    tokenProgramId
                );

                // Convert amount to the smallest unit
                const tokenAmount = BigInt(Math.floor(parseFloat(r.amount) * 10 ** decimals));

                // Build the transfer instruction
                const transferIx = createTransferInstruction(
                    senderAta.address,
                    recipientAta.address,
                    this.payer.publicKey,
                    Number(tokenAmount),
                    [],
                    tokenProgramId
                );

                // Add to transaction
                tx.add(transferIx);
            }

            // Send the transaction
            const signature = await sendAndConfirmTransaction(this.connection, tx, [this.payer]);

            // Log and notify about the successful transaction
            const successMsg = notifierMessage.formatSuccessSolanaMultiTransaction(currency, signature, this.payer.publicKey.toBase58());
            logger.info(this.network, successMsg);
            await modules.sendMessageToTelegram(successMsg);

            return signature;
        } catch (error) {
            throw error;
        }
    }
}
