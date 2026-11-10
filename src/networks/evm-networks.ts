/* External dependencies */
import { arbitrumSepolia, baseSepolia, bscTestnet, optimismSepolia, polygonAmoy, sepolia, type Chain } from 'viem/chains';

/* Constants */
import { Const } from '../constants/const';

/**
 * One EVM network the service pays on. Everything that used to be looked up in separate if/else chains (viem chain,
 * provider list, explorer link) comes from here, so a new network is one entry plus its lists in Const.
 */
export interface EvmNetwork {
    /** viem chain definition */
    chain: Chain;
    /** payway names accepted in requests, lowercase */
    payways: readonly string[];
    /** key of the provider list in Const.EVM_RPC_PROVIDERS (tests swap these lists for mock nodes) */
    rpcKey: string;
    /** explorer prefix a transaction hash is appended to */
    explorerTx: string;
    /** single provider used by the legacy getRpcUrl helper */
    legacyRpcUrl: string;
}

export const EVM_NETWORKS: readonly EvmNetwork[] = [
    { chain: sepolia, payways: Const.ETH_PAYWAY, rpcKey: 'eth', explorerTx: Const.TESTNET_EXPLORER.ETH, legacyRpcUrl: Const.ETH_TESTNET },
    { chain: bscTestnet, payways: Const.BSC_PAYWAY, rpcKey: 'bsc', explorerTx: Const.TESTNET_EXPLORER.BSC, legacyRpcUrl: Const.BSC_TESTNET },
    { chain: arbitrumSepolia, payways: Const.ARBITRUM_PAYWAY, rpcKey: 'arbitrum_eth', explorerTx: Const.TESTNET_EXPLORER.ARBITRUM, legacyRpcUrl: Const.ARBITRUM_TESTNET },
    { chain: baseSepolia, payways: Const.BASE_PAYWAY, rpcKey: 'base_eth', explorerTx: Const.TESTNET_EXPLORER.BASE, legacyRpcUrl: Const.BASE_TESTNET },
    { chain: polygonAmoy, payways: Const.POLYGON_PAYWAY, rpcKey: 'polygon_eth', explorerTx: Const.TESTNET_EXPLORER.POLYGON, legacyRpcUrl: Const.AMOY_POLYGON },
    { chain: optimismSepolia, payways: Const.OPTIMISM_PAYWAY, rpcKey: 'op_eth', explorerTx: Const.TESTNET_EXPLORER.OPTIMISM, legacyRpcUrl: Const.OPTIMISM_TESTNET }
];

/** The network of a payway (case-insensitive), or undefined */
export function findEvmNetwork(payway: string): EvmNetwork | undefined {
    const p = payway.toLowerCase();
    return EVM_NETWORKS.find((network) => network.payways.includes(p));
}

/** Every EVM payway name the service accepts */
export function evmPayways(): string[] {
    return EVM_NETWORKS.flatMap((network) => [...network.payways]);
}
