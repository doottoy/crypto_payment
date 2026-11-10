/* External dependencies */
import bs58 from 'bs58';
import { formatUnits, parseUnits } from 'viem';
import {
    Keypair,
    PublicKey,
    Connection,
    Transaction,
    SystemProgram,
    sendAndConfirmTransaction,
    type Signer,
    type TransactionInstruction
} from '@solana/web3.js';
import {
    getMint,
    getMintLen,
    calculateFee,
    ExtensionType,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    getTransferFeeConfig,
    createMintToInstruction,
    getAssociatedTokenAddressSync,
    createInitializeMintInstruction,
    createTransferCheckedInstruction,
    createTransferCheckedWithFeeInstruction,
    createInitializeTransferFeeConfigInstruction,
    createAssociatedTokenAccountIdempotentInstruction
} from '@solana/spl-token';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { ApiError } from '../api/errors';
import { fetchDecimals } from '../utils/modules';

/* Constants */
import { Const } from '../constants/const';

import type { ScenarioResult } from './evm.scenarios';

/** The chain access a Solana scenario needs; tests pass fakes */
export interface SolanaChain {
    connection: Connection;
    /** sends a setup transaction that must succeed and waits for its confirmation */
    sendAndConfirm: (tx: Transaction, signers: Signer[]) => Promise<string>;
}

export function devnet(): SolanaChain {
    const connection = new Connection(Const.SOLANA_DEVNET, 'confirmed');
    return { connection, sendAndConfirm: (tx, signers) => sendAndConfirmTransaction(connection, tx, signers) };
}

export function keypairFromSecret(secret: string): Keypair {
    const decoded = bs58.decode(secret);
    if (decoded.length === 64) return Keypair.fromSecretKey(decoded);
    if (decoded.length === 32) return Keypair.fromSeed(decoded);
    throw new ApiError(400, 'invalid_request', 'private_key must be a base58 secret key (64 bytes) or seed (32 bytes)');
}

async function tokenAmountOf(connection: Connection, account: PublicKey): Promise<bigint> {
    try {
        return BigInt((await connection.getTokenAccountBalance(account)).value.amount);
    } catch {
        // no such account yet: nothing held
        return 0n;
    }
}

/**
 * A transfer that lands in a block and fails: the fee is charged, nothing moves. A deposit system that credits on
 * the transfer instruction without checking the transaction error credits it. The transfer asks for more than the
 * sender holds and skips preflight, which would otherwise refuse it before it reaches a block.
 */
export async function failedSolanaTransfer(
    input: { privateKey: string; payee: string; amount: string; tokenMint?: string; isToken2022?: boolean; requestId?: string },
    chain: SolanaChain = devnet()
): Promise<ScenarioResult> {
    const { connection } = chain;
    const payer = keypairFromSecret(input.privateKey);
    const payee = new PublicKey(input.payee);
    let instructions: TransactionInstruction[];
    let requested: bigint;

    if (!input.tokenMint) {
        requested = BigInt(await connection.getBalance(payer.publicKey)) + parseUnits(input.amount, 9);
        instructions = [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payee, lamports: requested })];
    } else {
        const programId = input.isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
        const mint = new PublicKey(input.tokenMint);
        const decimals = await fetchDecimals(connection, input.tokenMint);
        const senderAta = getAssociatedTokenAddressSync(mint, payer.publicKey, false, programId);
        const payeeAta = getAssociatedTokenAddressSync(mint, payee, true, programId);
        requested = (await tokenAmountOf(connection, senderAta)) + parseUnits(input.amount, decimals);
        instructions = [
            createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, senderAta, payer.publicKey, mint, programId),
            createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, payeeAta, payee, mint, programId),
            createTransferCheckedInstruction(senderAta, mint, payeeAta, payer.publicKey, requested, decimals, [], programId)
        ];
    }

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(...instructions);
    tx.sign(payer);
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
    const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');

    if (!confirmation.value.err) {
        throw new ApiError(422, 'scenario_not_reproduced', `Transaction ${signature} succeeded: the sender held more than its balance read said`, { tx_id: signature });
    }
    logger.info('SOLANA', `🧪[SCENARIO][FAILED_TRANSFER][SIG:${signature}][ERR:${JSON.stringify(confirmation.value.err)}]`);
    return {
        scenario: 'solana/failed_transfer',
        txId: signature,
        expected: 'not credited: the transaction is in a block but failed, no balance moved',
        details: { payee: input.payee, token_mint: input.tokenMint ?? null, amount_in_instruction: requested.toString(), error: confirmation.value.err }
    };
}

/**
 * A Token-2022 transfer that pays a transfer fee: the recipient account is credited the amount minus the fee, and the
 * fee stays withheld in it. A deposit system that credits the amount of the instruction credits more than arrived.
 * Without `mint` a new Token-2022 mint with a TransferFeeConfig is created (rent paid by the sender); pass the `mint`
 * of an earlier answer to reuse it (same key: it is the mint authority).
 */
export async function token2022TransferFee(
    input: { privateKey: string; payee: string; amount: string; feeBasisPoints?: number; maxFee?: string; decimals?: number; mint?: string; requestId?: string },
    chain: SolanaChain = devnet()
): Promise<ScenarioResult> {
    const { connection } = chain;
    const payer = keypairFromSecret(input.privateKey);
    const payee = new PublicKey(input.payee);

    let mint: PublicKey;
    let decimals: number;
    let feeBasisPoints: number;
    let maximumFee: bigint;
    let mintCreated = false;

    if (input.mint) {
        mint = new PublicKey(input.mint);
        const mintInfo = await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
        const config = getTransferFeeConfig(mintInfo);
        if (!config) throw new ApiError(400, 'invalid_request', `mint ${input.mint} has no transfer fee extension`);
        decimals = mintInfo.decimals;
        feeBasisPoints = config.newerTransferFee.transferFeeBasisPoints;
        maximumFee = config.newerTransferFee.maximumFee;
    } else {
        decimals = input.decimals ?? 6;
        feeBasisPoints = input.feeBasisPoints ?? 100;
        maximumFee = input.maxFee !== undefined ? parseUnits(input.maxFee, decimals) : parseUnits(input.amount, decimals);
        const mintKeypair = Keypair.generate();
        const space = getMintLen([ExtensionType.TransferFeeConfig]);
        const lamports = await connection.getMinimumBalanceForRentExemption(space);
        const createMint = new Transaction().add(
            SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mintKeypair.publicKey, space, lamports, programId: TOKEN_2022_PROGRAM_ID }),
            createInitializeTransferFeeConfigInstruction(mintKeypair.publicKey, payer.publicKey, payer.publicKey, feeBasisPoints, maximumFee, TOKEN_2022_PROGRAM_ID),
            createInitializeMintInstruction(mintKeypair.publicKey, decimals, payer.publicKey, null, TOKEN_2022_PROGRAM_ID)
        );
        await chain.sendAndConfirm(createMint, [payer, mintKeypair]);
        mint = mintKeypair.publicKey;
        mintCreated = true;
    }

    const amount = parseUnits(input.amount, decimals);
    // the program checks the fee in the instruction against its own computation, so use its rule
    const fee = calculateFee({ epoch: 0n, maximumFee, transferFeeBasisPoints: feeBasisPoints }, amount);
    const senderAta = getAssociatedTokenAddressSync(mint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const payeeAta = getAssociatedTokenAddressSync(mint, payee, true, TOKEN_2022_PROGRAM_ID);

    const transfer = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, senderAta, payer.publicKey, mint, TOKEN_2022_PROGRAM_ID),
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, payeeAta, payee, mint, TOKEN_2022_PROGRAM_ID),
        createMintToInstruction(mint, senderAta, payer.publicKey, amount, [], TOKEN_2022_PROGRAM_ID),
        createTransferCheckedWithFeeInstruction(senderAta, mint, payeeAta, payer.publicKey, amount, decimals, fee, [], TOKEN_2022_PROGRAM_ID)
    );
    const signature = await chain.sendAndConfirm(transfer, [payer]);
    logger.info('SOLANA', `🧪[SCENARIO][TOKEN2022_FEE][MINT:${mint.toBase58()}][FEE:${fee}][SIG:${signature}]`);

    const received = amount - fee;
    const unit = (value: bigint) => formatUnits(value, decimals);
    return {
        scenario: 'solana/token2022_transfer_fee',
        txId: signature,
        expected: `credit ${unit(received)}, not ${unit(amount)}: the transfer fee (${feeBasisPoints / 100}%) stays withheld in the recipient account`,
        details: {
            mint: mint.toBase58(),
            mint_created: mintCreated,
            decimals,
            fee_basis_points: feeBasisPoints,
            max_fee: unit(maximumFee),
            sent: unit(amount),
            fee: unit(fee),
            received: unit(received),
            payee_token_account: payeeAta.toBase58()
        }
    };
}
