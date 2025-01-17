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
    createTransferInstruction,
    getOrCreateAssociatedTokenAccount
} from '@solana/spl-token';

/* Internal dependencies */
import { modules } from '../utils/modules';
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
        isToken2022: boolean = false
    ): Promise<string> {
        try {
            // If no tokenMint, treat as native SOL
            if (!tokenMint) {
                return await this.sendNativeSOL(payeeAddress, amount, currency);
            } else {
                // Otherwise, SPL-token
                return await this.sendSPLToken(payeeAddress, amount, tokenMint, isToken2022, currency);
            }
        } catch (error) {
            // Handle and format the error
            const formattedError = formatSolanaError(error);

            // Notify via Telegram
            await modules.sendMessageToTelegram(notifierMessage.formatErrorSolana(currency, formattedError));
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
        currency: string
    ): Promise<string> {
        try {
            const lamports = Math.floor(parseFloat(amount) * 1e9);
            const tx = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: this.payer.publicKey,
                    toPubkey: new PublicKey(payeeAddress),
                    lamports
                })
            );
            const signature = await sendAndConfirmTransaction(this.connection, tx, [this.payer]);

            // Log and notify about the successful transaction
            console.log(notifierMessage.formatSuccessSolanaTransaction(currency, signature, this.payer.publicKey.toBase58(), amount));
            await modules.sendMessageToTelegram(notifierMessage.formatSuccessSolanaTransaction(currency, signature, this.payer.publicKey.toBase58(), amount));

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
        currency: string
    ): Promise<string> {
        try {
            const mintPubkey = new PublicKey(tokenMint);
            const payeePubkey = new PublicKey(payeeAddress);
            const tokenProgramId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

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

            const decimals = await this.fetchDecimals(tokenMint);
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
            console.log(notifierMessage.formatSuccessSolanaTransaction(currency, signature, this.payer.publicKey.toBase58(), amount));
            await modules.sendMessageToTelegram(notifierMessage.formatSuccessSolanaTransaction(currency, signature, this.payer.publicKey.toBase58(), amount));

            return signature;
        } catch (error) {
            throw error;
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
        ownerAddress?: string
    ): Promise<string> {
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
            console.log(notifierMessage.formatSolanaCreateTokenAccount(newTokenAccountPubkey.toBase58(), ownerPubKey));
            await modules.sendMessageToTelegram(notifierMessage.formatSolanaCreateTokenAccount(newTokenAccountPubkey.toBase58(), ownerPubKey));

            // Return token account address
            return newTokenAccountPubkey.toBase58();
        } catch (error) {
            throw error;
        }
    }

    /**
     * Fetches the decimals for a given SPL token mint.
     * @param tokenMint - The mint address of the SPL token.
     * @returns The number of decimals.
     */
    private async fetchDecimals(tokenMint: string): Promise<number> {
        const mintInfo = await this.connection.getParsedAccountInfo(new PublicKey(tokenMint));
        console.log(mintInfo.value)
        if (
            mintInfo.value &&
            mintInfo.value.data &&
            'parsed' in mintInfo.value.data &&
            'info' in mintInfo.value.data.parsed &&
            'decimals' in mintInfo.value.data.parsed.info
        ) {
            return mintInfo.value.data.parsed.info.decimals;
        } else {
            return 6;
        };
    }
}
