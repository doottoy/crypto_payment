/* External dependencies */
import { arbitrumSepolia, baseSepolia, bscTestnet, polygonAmoy, sepolia, type Chain } from 'viem/chains';

/* Constants */
import { Const } from '../constants/const';

/**
 * Resolves viem chain config by logical payway name.
 */
export function getChainForPayway(payway: string): Chain {
    const p = payway.toLowerCase();

    if ((Const.ETH_PAYWAY as readonly string[]).includes(p)) return sepolia;
    if ((Const.BSC_PAYWAY as readonly string[]).includes(p)) return bscTestnet;
    if ((Const.ARBITRUM_PAYWAY as readonly string[]).includes(p)) return arbitrumSepolia;
    if ((Const.BASE_PAYWAY as readonly string[]).includes(p)) return baseSepolia;
    if ((Const.POLYGON_PAYWAY as readonly string[]).includes(p)) return polygonAmoy;

    throw new Error(`Unsupported payway for chain mapping: ${payway}`);
}

/**
 * Determines whether an error is network-related (DNS, timeout, connection).
 */
export function isEvmNetworkError(err: any): boolean {
    const msg = (
        err?.message ||
        err?.data?.message ||
        err?.toString?.() ||
        ''
    ).toLowerCase();

    return (Const.NETWORK_ERROR_PATTERNS as readonly string[]).some((sub) => msg.includes(sub));
}


