import { config } from 'dotenv';
import { AbiItem } from 'web3-utils';

config();

// Constants
export const Const = {
    // Gas limit for multi-send transactions
    MULTI_SEND_GAS_LIMIT: 1000000,

    // Tron fee limit
    TRON_FEE_LIMIT: 100000000,

    EVM_FEE: {
        GWEI: 10n ** 9n,
        TIP_FLOOR_POLYGON: 25n * (10n ** 9n),
        MAX_TIP_CAP: 200n * (10n ** 9n),
        MAX_FEE_CAP: 500n * (10n ** 9n),
    },

    EVM_RPC_PROVIDERS: {
        eth: [
            'https://ethereum-sepolia-rpc.publicnode.com',
            'https://eth-sepolia.g.alchemy.com/public',
            'https://sepolia.infura.io/v3/7a4583d0b3014189bbff7f24582fc5ea'
        ],
        bsc: [
            'https://bsc-testnet.bnbchain.org',
            'https://bsc-testnet-rpc.publicnode.com',
            'https://bnb-testnet.g.alchemy.com/public',
            'https://bsc-testnet.infura.io/v3/7a4583d0b3014189bbff7f24582fc5ea'
        ],
        arbitrum_eth: [
            'https://arbitrum-sepolia-rpc.publicnode.com',
            'https://arb-sepolia.g.alchemy.com/public',
            'https://arbitrum-sepolia.infura.io/v3/7a4583d0b3014189bbff7f24582fc5ea'
        ],
        base_eth: [
            'https://sepolia.base.org',
            'https://base-sepolia-rpc.publicnode.com',
            'https://base-sepolia.g.alchemy.com/public',
            'https://base-sepolia.infura.io/v3/7a4583d0b3014189bbff7f24582fc5ea'
        ],
        polygon_eth: [
            'https://polygon-amoy-bor-rpc.publicnode.com',
            'https://polygon-amoy.g.alchemy.com/public',
            'https://polygon-amoy.infura.io/v3/7a4583d0b3014189bbff7f24582fc5ea'
        ],
    } as Record<string, string[]>,

    // Testnet providers urls
    BSC_TESTNET: 'https://bsc-testnet.bnbchain.org',
    ETH_TESTNET: 'https://ethereum-sepolia-rpc.publicnode.com',
    ARBITRUM_TESTNET: 'https://arbitrum-sepolia-rpc.publicnode.com',
    BASE_TESTNET: 'https://sepolia.base.org',
    SOLANA_DEVNET: 'https://api.devnet.solana.com',
    TRON_NILE: 'https://nile.trongrid.io',
    AMOY_POLYGON: 'https://polygon-amoy.g.alchemy.com/public',

    // Supported ETH payways
    ETH_PAYWAY: ['eth', 'erc20'],

    // Supported BSC payways
    BSC_PAYWAY: ['bsc', 'bep20'],

    // Supported LTC payway
    LTC_PAYWAY: ['ltc'],

    // Supported Arbitrum payways
    ARBITRUM_PAYWAY: ['arbitrum_eth', 'arbitrum_erc20'],

    // Supported Base payways
    BASE_PAYWAY: ['base_eth', 'base_erc20'],

    // Supported Polygon payways
    POLYGON_PAYWAY: ['polygon_eth', 'polygon_erc20'],

    // ABI definition for a basic transfer function
    ABI_CONTRACT: [
        {
            constant: false,
            inputs: [
                { name: '_to', type: 'address' },
                { name: '_value', type: 'uint256' }
            ],
            name: 'transfer',
            outputs: [{ name: '', type: 'bool' }],
            payable: false,
            stateMutability: 'nonpayable',
            type: 'function'
        }
    ] as AbiItem[],

    // ABI definition for the multi-send function
    MULTI_SEND_ABI_CONTRACT: [
        {
            constant: false,
            inputs: [
                { name: 'recipients', type: 'address[]' },
                { name: 'amounts', type: 'uint256[]' }
            ],
            name: 'multiSend',
            outputs: [],
            payable: true,
            stateMutability: 'payable',
            type: 'function'
        },
        {
            constant: true,
            inputs: [],
            name: "decimals",
            outputs: [{ name: "", type: "uint8" }],
            type: "function",
        }
    ] as AbiItem[],

    // Testnet explorers urls
    TESTNET_EXPLORER: {
        BSC: 'https://testnet.bscscan.com/tx/',
        ETH: 'https://sepolia.etherscan.io/tx/',
        ARBITRUM: 'https://sepolia.arbiscan.io/tx/',
        BASE: 'https://sepolia.basescan.org/tx/',
        LTC: 'https://litecoinspace.org/testnet/tx/',
        SOLANA: 'https://solscan.io/tx/',
        SOLANA_ADDRESS: 'https://explorer.solana.com/address/',
        NILE_TRON: 'https://nile.tronscan.org/#/transaction/',
        POLYGON: 'https://amoy.polygonscan.com/tx/'
    },

    // Decimals method
    DECIMALS: {
        0: 'wei',
        3: 'gwei',
        6: 'mwei',
        9: 'gwei',
        12: 'tera',
        18: 'ether'
    } as Record<number, string>,

    // Method and rpc for request
    RPC: '2.0' as string,
    POST: 'POST' as string,
    APPLICATION_JSON: 'application/json' as string,

    NETWORK_ERROR_PATTERNS: [
        'timeout',
        'timed out',
        'socket hang up',
        'connection error',
        'connect econnrefused',
        'connection refused',
        'connection reset',
        'econnreset',
        'econnrefused',
        'enotfound',
        'host not found',
        'could not connect',
        "couldn't connect",
        'failed to fetch',
        'network error',
        'network down',
        'invalid json rpc',
        '503 service unavailable',
        '502 bad gateway',
        'bad gateway',
        'service unavailable',
        'gateway timeout',
        'connection closed',
        'disconnected',
        'server unavailable',
        'unreachable',
        'getaddrinfo enotfound',
        'connection aborted',
        'ssl routines',
        'ssl error',
        'tlsv1 alert',
        'http request failed',
        'request failed with status code 5',
        'temporarily unavailable',
        'backend error',
        'peer not reachable',
        'dns lookup failed',
        'cannot assign requested address',
        'no route to host',
        'connection timed out',
        'websocket is not open',
        'closed before a response was received',
        'request aborted',
        'socket hangup',
        'pending transaction exists',
        'unable to get nonce',
        'nonce too low',
        'failed to meet quorum',
        'rate limit',
        'request limit',
        'exceeded quota',
        'insufficient funds for gas',
        'block not found',
        'missing response',
        'no response',
        'response error',
        'could not detect network',
        'response closed without headers',
        'could not retrieve chain id',
        'unable to get chain id',
        'is not enabled for this app',
        'context deadline exceeded',
        'tls handshake timeout',
        'client connection lost',
        'too many requests',
        'http 429',
        '520 origin error',
        '522 origin connection time-out',
        '524 a timeout occurred',
        'request entity too large',
        'typeerror: networkerror'
    ] as string[],
    FEE_BUMP_ERROR_PATTERNS: [
        'replacement transaction underpriced',
        'fee too low',
        'nonce too low',
        'already known'
    ] as string[],
    MINIMUM_TIP_ERROR_PATTERNS: [
        'minimum needed',
        'gas price below minimum',
        'tip cap'
    ] as string[],
};