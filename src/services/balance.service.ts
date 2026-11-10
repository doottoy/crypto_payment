/* External dependencies */
import { TronWeb } from 'tronweb';
import { Connection, PublicKey } from '@solana/web3.js';
import { createPublicClient, formatUnits, http, isAddress, parseUnits, type Address, type PublicClient } from 'viem';

/* Internal dependencies */
import { ApiError, CoreRpcError } from '../api/errors';
import { toPlainDecimal } from '../api/schemas';
import { fetchDecimals, makeRpcRequest } from '../utils/modules';
import { findEvmNetwork } from '../networks/evm-networks';
import { isEvmNetworkError, isEvmProviderError } from '../utils/evm';

/* Constants */
import { Const } from '../constants/const';

export type BalanceChain = 'evm' | 'solana' | 'tron' | 'ltc';

export interface BalanceQuery {
    payway: string;
    address?: string;
    token?: string;
}

export interface Balance {
    chain: BalanceChain;
    payway: string;
    address: string | null;
    token: string | null;
    symbol: string | null;
    decimals: number;
    /** human units, e.g. "1.5" */
    balance: string;
    /** base units (wei, lamports, sun, litoshi) */
    raw: string;
}

const SOLANA_PAYWAYS = ['sol', 'solana', 'spl'];
const TRON_PAYWAYS = ['tron', 'trx', 'trc20'];
const LTC_PAYWAYS = ['ltc', 'litecoin'];

const ERC20_READ_ABI = [
    { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
    { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
    { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] }
] as const;

/** Which chain a payway belongs to, or undefined */
export function balanceChainOf(payway: string): BalanceChain | undefined {
    const p = payway.toLowerCase();
    if (findEvmNetwork(p)) return 'evm';
    if (SOLANA_PAYWAYS.includes(p)) return 'solana';
    if (TRON_PAYWAYS.includes(p)) return 'tron';
    if (LTC_PAYWAYS.includes(p)) return 'ltc';
    return undefined;
}

export function supportedBalancePayways(): string[] {
    return [...new Set([...Const.ETH_PAYWAY, ...Const.BSC_PAYWAY, ...Const.ARBITRUM_PAYWAY, ...Const.BASE_PAYWAY,
        ...Const.POLYGON_PAYWAY, ...Const.OPTIMISM_PAYWAY, ...SOLANA_PAYWAYS, ...TRON_PAYWAYS, ...LTC_PAYWAYS])];
}

function result(chain: BalanceChain, query: BalanceQuery, raw: bigint, decimals: number, symbol: string | null): Balance {
    return {
        chain,
        payway: query.payway.toLowerCase(),
        address: query.address ?? null,
        token: query.token ?? null,
        symbol,
        decimals,
        balance: formatUnits(raw, decimals),
        raw: raw.toString()
    };
}

/** Native or ERC20 balance, failing over between the providers of the network like the payouts do */
async function evmBalance(query: BalanceQuery): Promise<Balance> {
    const network = findEvmNetwork(query.payway);
    if (!network) throw new ApiError(400, 'invalid_request', `Unknown EVM payway: ${query.payway}`);
    if (!query.address) throw new ApiError(400, 'invalid_request', 'address is required for EVM balances');

    let lastError: unknown;
    for (const url of Const.EVM_RPC_PROVIDERS[network.rpcKey]) {
        const client = createPublicClient({ chain: network.chain, transport: http(url, { timeout: 10000 }) }) as PublicClient;
        try {
            const owner = query.address as Address;
            if (!query.token) {
                const raw = await client.getBalance({ address: owner });
                return result('evm', query, raw, network.chain.nativeCurrency.decimals, network.chain.nativeCurrency.symbol);
            }
            const token = query.token as Address;
            const [raw, decimals, symbol] = await Promise.all([
                client.readContract({ address: token, abi: ERC20_READ_ABI, functionName: 'balanceOf', args: [owner] }),
                client.readContract({ address: token, abi: ERC20_READ_ABI, functionName: 'decimals' }),
                client.readContract({ address: token, abi: ERC20_READ_ABI, functionName: 'symbol' }).catch(() => null)
            ]);
            return result('evm', query, raw as bigint, Number(decimals), (symbol as string | null) ?? null);
        } catch (error) {
            lastError = error;
            if (!isEvmNetworkError(error) && !isEvmProviderError(error)) throw error;
        }
    }
    throw new Error(`All RPC providers failed for balance on ${query.payway}: ${(lastError as any)?.shortMessage || (lastError as any)?.message || lastError}`);
}

/** SOL, or the sum of every token account the owner holds for the mint (SPL and Token-2022) */
export async function solanaBalance(query: BalanceQuery, connection: Connection = new Connection(Const.SOLANA_DEVNET, 'confirmed')): Promise<Balance> {
    if (!query.address) throw new ApiError(400, 'invalid_request', 'address is required for Solana balances');
    const owner = new PublicKey(query.address);

    if (!query.token) {
        const lamports = await connection.getBalance(owner);
        return result('solana', query, BigInt(lamports), 9, 'SOL');
    }

    const mint = new PublicKey(query.token);
    const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint });
    let raw = 0n;
    let decimals: number | undefined;
    for (const { account } of accounts.value) {
        const amount = (account.data as any)?.parsed?.info?.tokenAmount;
        if (!amount) continue;
        raw += BigInt(amount.amount);
        decimals = amount.decimals;
    }
    return result('solana', query, raw, decimals ?? await fetchDecimals(connection, query.token), null);
}

/** TRX, or a TRC20 balance through a constant call (no key needed) */
export async function tronBalance(query: BalanceQuery, tronWeb: any = new TronWeb({ fullHost: Const.TRON_NILE })): Promise<Balance> {
    if (!query.address) throw new ApiError(400, 'invalid_request', 'address is required for Tron balances');
    // Constant calls need an owner address; the queried one is as good as any and needs no key
    tronWeb.setAddress(query.address);

    if (!query.token) {
        const sun = await tronWeb.trx.getBalance(query.address);
        return result('tron', query, BigInt(sun), 6, 'TRX');
    }

    const contract = await tronWeb.contract().at(query.token);
    const [raw, decimals, symbol] = await Promise.all([
        contract.balanceOf(query.address).call(),
        contract.decimals().call(),
        contract.symbol().call().catch(() => null)
    ]);
    return result('tron', query, BigInt(raw.toString()), Number(decimals.toString()), symbol ? String(symbol) : null);
}

/** The Litecoin node wallet balance; the node cannot report an arbitrary address */
async function ltcBalance(query: BalanceQuery): Promise<Balance> {
    if (query.address || query.token) {
        throw new ApiError(400, 'invalid_request', 'Litecoin balances are the balance of the node wallet: omit address and token');
    }
    const response = await makeRpcRequest<number>('getbalance', []);
    if (response.error || response.result === null || response.result === undefined) {
        throw new CoreRpcError('getbalance', response.error?.code, response.error?.message || 'the node returned no balance');
    }
    const raw = parseUnits(toPlainDecimal(response.result), 8);
    return result('ltc', query, raw, 8, 'LTC');
}

function isSolanaKey(value: string): boolean {
    try {
        // eslint-disable-next-line no-new
        new PublicKey(value);
        return true;
    } catch {
        return false;
    }
}

/** A malformed address is the caller's mistake: a 400 naming it, not a 500 from deep inside a client library */
function assertAddresses(chain: BalanceChain, query: BalanceQuery): void {
    const valid: Record<Exclude<BalanceChain, 'ltc'>, (value: string) => boolean> = {
        evm: (value) => isAddress(value),
        solana: isSolanaKey,
        tron: (value) => TronWeb.isAddress(value)
    };
    if (chain === 'ltc') return;
    for (const field of ['address', 'token'] as const) {
        const value = query[field];
        if (value !== undefined && !valid[chain](value)) {
            throw new ApiError(400, 'invalid_request', `${field}: "${value}" is not a valid ${chain === 'evm' ? 'EVM' : chain === 'solana' ? 'Solana' : 'Tron'} address`);
        }
    }
}

export async function getBalance(query: BalanceQuery): Promise<Balance> {
    const chain = balanceChainOf(query.payway);
    if (chain) assertAddresses(chain, query);
    switch (chain) {
        case 'evm': return evmBalance(query);
        case 'solana': return solanaBalance(query);
        case 'tron': return tronBalance(query);
        case 'ltc': return ltcBalance(query);
        default:
            throw new ApiError(400, 'invalid_request', `Unsupported payway for balances: ${query.payway} (supported: ${supportedBalancePayways().join(', ')})`);
    }
}
