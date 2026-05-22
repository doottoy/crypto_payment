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
    createAccount,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    getAssociatedTokenAddress,
    createTransferInstruction,
    createCloseAccountInstruction,
    createTransferCheckedInstruction,
    getOrCreateAssociatedTokenAccount,
    createAssociatedTokenAccountInstruction,
    createAssociatedTokenAccountIdempotentInstruction
} from '@solana/spl-token';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { modules, fetchDecimals } from '../utils/modules';
import { notifierMessage } from '../utils/message-formatter';
import { formatSolanaError } from '../utils/solana-error-handler';

/* Constants */
import { Const } from '../constants/const';

/**
 * Service class for handling Solana transactions (native SOL or SPL-token).
 */
export class SolanaPayoutService {
    private connection: Connection;
    private payer!: Keypair;

    /**
     * @param payway - Network identifier
     * @param privateKey - Base58-encoded private key (32 or 64 bytes)
     */
    constructor(private payway: string, private privateKey: string) {
        this.connection = new Connection(Const.SOLANA_DEVNET, 'confirmed');
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
     * Main sendTransaction method, handling both native SOL and SPL-token transfers.
     *
     * @param payeeAddress - Recipient's address
     * @param amount - Amount to transfer
     * @param tokenMint - If provided, treat as SPL-token transfer
     * @param currency - Currency identifier for notifications
     * @param isToken2022 - Pass true for Token-2022 minted tokens
     * @returns Transaction signature (hash)
     */
    public async sendTransaction(
        payeeAddress: string,
        amount: string,
        currency: string,
        tokenMint?: string,
        isToken2022: boolean = false,
        requestId?: string
    ): Promise<string> {
        const network = this.payway.toUpperCase();
        try {
            // If no tokenMint, treat as native SOL
            if (!tokenMint) {
                return await this.sendNativeSOL(payeeAddress, amount, currency, network, requestId);
            } else {
                // Otherwise, SPL-token
                return await this.sendSPLToken(payeeAddress, amount, tokenMint, isToken2022, currency, network, requestId);
            }
        } catch (error) {
            // Handle and format the error
            const formattedError = formatSolanaError(error);
            const reqInfo = requestId ? `[${requestId}]` : '';
            logger.error(network, `❌${reqInfo}[ERROR][MSG:${formattedError}]`);

            // Notify via Telegram
            await modules.sendMessageToTelegram(notifierMessage.formatErrorSolana(currency, formattedError, requestId));
            throw new Error(formattedError);
        }
    }

    /**
     * Internal function: sends native SOL.
     *
     * @param payeeAddress - Recipient address
     * @param amount - Amount in SOL
     * @param currency- Currency identifier for notifications
     * @returns Transaction signature (hash)
     */
    private async sendNativeSOL(
        payeeAddress: string,
        amount: string,
        currency: string,
        network: string,
        requestId?: string
    ): Promise<string> {
        try {
            const lamports = Math.floor(parseFloat(amount) * 1e9);
            const reqInfo = requestId ? `[${requestId}]` : '';
            logger.info(network, `🔄${reqInfo}[SEND][AMOUNT:${amount}][CUR:${currency}][TO:${payeeAddress}]`);

            const tx = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: this.payer.publicKey,
                    toPubkey: new PublicKey(payeeAddress),
                    lamports
                })
            );
            const signature = await sendAndConfirmTransaction(this.connection, tx, [this.payer]);

            // Log and notify about the successful transaction
            const successMsg = notifierMessage.formatSuccessSolanaTransaction(
                currency,
                signature,
                this.payer.publicKey.toBase58(),
                amount,
                requestId
            );
            logger.info(network, `✅${reqInfo}[CONFIRMED][HASH:${signature}]`);
            await modules.sendMessageToTelegram(successMsg);

            return signature;
        } catch (error) {
            throw error;
        }
    }

    /**
     * Internal function: sends SPL-token (classic or Token-2022).
     *
     * @param payeeAddress - Recipient's public key
     * @param amount - The amount to transfer
     * @param tokenMint - Mint address of the SPL-token
     * @param isToken2022 - Set true if mint is under Token-2022 program
     * @param currency - Currency identifier for notifications
     * @returns Transaction signature (hash)
     */
    private async sendSPLToken(
        payeeAddress: string,
        amount: string,
        tokenMint: string,
        isToken2022: boolean,
        currency: string,
        network: string,
        requestId?: string
    ): Promise<string> {
        try {
            const mintPubkey = new PublicKey(tokenMint);
            const payeePubkey = new PublicKey(payeeAddress);
            const tokenProgramId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
            const reqInfo = requestId ? `[${requestId}]` : '';
            logger.info(network, `🔄${reqInfo}[SEND][AMOUNT:${amount}][CUR:${currency}][TO:${payeeAddress}][MINT:${tokenMint}]`);

            // Create/find ATA for sender
            const senderAta = await (getOrCreateAssociatedTokenAccount as any)(
                this.connection,
                this.payer,
                mintPubkey,
                this.payer.publicKey,
                false,
                undefined,
                undefined,
                tokenProgramId
            );

            // Create/find ATA for recipient
            const recipientAta = await (getOrCreateAssociatedTokenAccount as any)(
                this.connection,
                this.payer,
                mintPubkey,
                payeePubkey,
                false,
                undefined,
                undefined,
                tokenProgramId
            );

            const decimals = await fetchDecimals(this.connection, tokenMint);
            const tokenAmount = BigInt(Math.floor(parseFloat(amount) * 10 ** decimals));

            // Create transfer instruction
            const transferIx = (createTransferInstruction as any)(
                senderAta.address,
                recipientAta.address,
                this.payer.publicKey,
                Number(tokenAmount),
                [],
                tokenProgramId
            );

            const tx = new Transaction().add(transferIx);
            const signature = await sendAndConfirmTransaction(this.connection, tx, [this.payer]);

            // Log and notify about the successful transaction
            const successMsg = notifierMessage.formatSuccessSolanaTransaction(
                currency,
                signature,
                this.payer.publicKey.toBase58(),
                amount,
                requestId
            );
            logger.info(network, `✅${reqInfo}[CONFIRMED][HASH:${signature}]`);
            await modules.sendMessageToTelegram(successMsg);

            return signature;
        } catch (error) {
            throw error;
        }
    }

    /**
     * Sends SPL tokens via an ephemeral intermediate ATA in a single transaction.
     * 
     * @param payeeAddress - Final recipient (owner of the destination ATA)
     * @param amount - Amount to transfer (human-readable units)
     * @param tokenMint - Mint address of the SPL-token (classic or Token-2022)
     * @param currency - Currency identifier for notifications/logging
     * @param isToken2022 - Pass true for Token-2022 minted tokens
     * @param requestId - Optional request identifier for log/notification correlation
     * @returns Transaction signature (hash)
     */
    public async sendWithIntermediateAta(
        payeeAddress: string,
        amount: string,
        tokenMint: string,
        currency: string,
        isToken2022: boolean = false,
        requestId?: string
    ): Promise<string> {
        const network = this.payway.toUpperCase();
        const reqInfo = requestId ? `[${requestId}]` : '';
        try {
            const mintPubkey = new PublicKey(tokenMint);
            const payeePubkey = new PublicKey(payeeAddress);
            const tokenProgramId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

            // Ephemeral keypair that owns the intermediate ATA (signs leg #4 and CloseAccount).
            // Mirrors the bridge/router pattern where the intermediate's owner is a
            // distinct address from sender and recipient.
            const intermediateOwner = Keypair.generate();

            logger.info(
                network,
                `🔄${reqInfo}[INTERMEDIATE_ATA_SEND][AMOUNT:${amount}][CUR:${currency}][TO:${payeeAddress}][MINT:${tokenMint}][INTERMEDIATE_OWNER:${intermediateOwner.publicKey.toBase58()}]`
            );

            // Make sure payer's source ATA exists and is funded — outside the tx,
            // so the test transaction itself contains exactly the bug pattern.
            const senderAta = await (getOrCreateAssociatedTokenAccount as any)(
                this.connection,
                this.payer,
                mintPubkey,
                this.payer.publicKey,
                false,
                undefined,
                undefined,
                tokenProgramId
            );

            // Pre-compute ATAs that will be created inside the tx.
            const intermediateAta = await getAssociatedTokenAddress(
                mintPubkey,
                intermediateOwner.publicKey,
                false,
                tokenProgramId
            );
            const destinationAta = await getAssociatedTokenAddress(
                mintPubkey,
                payeePubkey,
                false,
                tokenProgramId
            );

            const decimals = await fetchDecimals(this.connection, tokenMint);
            const tokenAmount = BigInt(Math.floor(parseFloat(amount) * 10 ** decimals));

            const tx = new Transaction();

            // 1. Create intermediate ATA
            tx.add(
                createAssociatedTokenAccountInstruction(
                    this.payer.publicKey,
                    intermediateAta,
                    intermediateOwner.publicKey,
                    mintPubkey,
                    tokenProgramId
                )
            );

            // 2. Create destination ATA (idempotent — payee ATA may already exist)
            tx.add(
                createAssociatedTokenAccountIdempotentInstruction(
                    this.payer.publicKey,
                    destinationAta,
                    payeePubkey,
                    mintPubkey,
                    tokenProgramId
                )
            );

            // 3. TransferChecked: sender → intermediate (transit leg)
            tx.add(
                createTransferCheckedInstruction(
                    senderAta.address,
                    mintPubkey,
                    intermediateAta,
                    this.payer.publicKey,
                    tokenAmount,
                    decimals,
                    [],
                    tokenProgramId
                )
            );

            // 4. TransferChecked: intermediate → destination (the leg the parser used to drop)
            tx.add(
                createTransferCheckedInstruction(
                    intermediateAta,
                    mintPubkey,
                    destinationAta,
                    intermediateOwner.publicKey,
                    tokenAmount,
                    decimals,
                    [],
                    tokenProgramId
                )
            );

            // 5. Close intermediate ATA; rent goes back to payer
            tx.add(
                createCloseAccountInstruction(
                    intermediateAta,
                    this.payer.publicKey,
                    intermediateOwner.publicKey,
                    [],
                    tokenProgramId
                )
            );

            const signature = await sendAndConfirmTransaction(
                this.connection,
                tx,
                [this.payer, intermediateOwner]
            );

            const successMsg = notifierMessage.formatSuccessSolanaTransaction(
                currency,
                signature,
                this.payer.publicKey.toBase58(),
                amount,
                requestId
            );
            logger.info(network, `✅${reqInfo}[INTERMEDIATE_ATA_CONFIRMED][HASH:${signature}]`);
            await modules.sendMessageToTelegram(successMsg);

            return signature;
        } catch (error) {
            const formattedError = formatSolanaError(error);
            logger.error(network, `❌${reqInfo}[INTERMEDIATE_ATA_ERROR][MSG:${formattedError}]`);
            await modules.sendMessageToTelegram(notifierMessage.formatErrorSolana(currency, formattedError, requestId));
            throw new Error(formattedError);
        }
    }

    /**
     * Creates a new (non-associated) token account
     *
     * @param tokenMint - mint address
     * @param ownerAddress - (optional) address of the owner. If not passed, the owner is `this.payer.publicKey`.
     * @returns PublicKey of the newly created account in base58 string format
     */
    public async createNewTokenAccount(
        tokenMint: string,
        ownerAddress?: string,
        requestId?: string
    ): Promise<string> {
        const network = this.payway.toUpperCase();
        try {
            const newKeypair = Keypair.generate();
            const mintPublicKey = new PublicKey(tokenMint);
            const ownerPubKey = ownerAddress
                ? new PublicKey(ownerAddress)
                : this.payer.publicKey;

            // Create non-ATA token account
            const newTokenAccountPubkey = await createAccount(
                this.connection,
                this.payer,
                mintPublicKey,
                ownerPubKey,
                newKeypair,
                undefined,
                TOKEN_2022_PROGRAM_ID
            );

            // Log and notify about the successful transaction
            const successMsg = notifierMessage.formatSolanaCreateTokenAccount(
                newTokenAccountPubkey.toBase58(),
                ownerPubKey,
                requestId
            );
            const reqInfo = requestId ? `[${requestId}]` : '';
            logger.info(network, `✅${reqInfo}[TOKEN_ACCOUNT_CREATED][ACCOUNT:${newTokenAccountPubkey.toBase58()}]`);
            await modules.sendMessageToTelegram(successMsg);

            // Return token account address
            return newTokenAccountPubkey.toBase58();
        } catch (error) {
            throw error;
        }
    }
}
