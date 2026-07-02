import { config } from 'dotenv';
import { AbiItem } from 'web3-utils';

config();

// Constants
export const Const = {
    // Gas limit for multi-send transactions
    MULTI_SEND_GAS_LIMIT: 1000000,

    // Tron fee limit
    TRON_FEE_LIMIT: 100000000,

    // Tron broadcast verification: the node can reject a broadcast ({ result: false, code })
    // while the locally-computed txid is still present in the response. Rejections with the
    // codes below are transient and safe to retry with a freshly built transaction.
    TRON_BROADCAST_MAX_ATTEMPTS: 3,
    TRON_BROADCAST_RETRY_DELAY_MS: 2000,
    // NOTE: 'BANDWITH_ERROR' is the actual (misspelled) enum value in java-tron
    TRON_BROADCAST_RETRYABLE_CODES: ['SERVER_BUSY', 'BANDWITH_ERROR', 'TAPOS_ERROR', 'TRANSACTION_EXPIRATION_ERROR'],

    EVM_FEE: {
        GWEI: 10n ** 9n,
        TIP_FLOORS: {
            eth: 2n * (10n ** 9n),
            erc20: 2n * (10n ** 9n),
            ethereum: 2n * (10n ** 9n),
            bsc: 3n * (10n ** 9n),
            bep20: 3n * (10n ** 9n),
            arbitrum_eth: 1n * (10n ** 8n),
            arbitrum_erc20: 1n * (10n ** 8n),
            arbitrum: 1n * (10n ** 8n),
            base_eth: 1n * (10n ** 8n),
            base_erc20: 1n * (10n ** 8n),
            base: 1n * (10n ** 8n),
            polygon_eth: 25n * (10n ** 9n),
            polygon_erc20: 25n * (10n ** 9n),
            polygon: 25n * (10n ** 9n),
        } as Record<string, bigint>,
        MAX_TIP_CAP: 200n * (10n ** 9n),
        MAX_FEE_CAP: 500n * (10n ** 9n),
    },

    EVM_RPC_PROVIDERS: {
        eth: [
            'https://sepolia.drpc.org',
            'https://ethereum-sepolia-rpc.publicnode.com',
            'https://eth-sepolia.g.alchemy.com/public',
            'https://sepolia.infura.io/v3/7a4583d0b3014189bbff7f24582fc5ea'
        ],
        bsc: [
            'https://bsc-testnet.drpc.org',
            'https://bsc-testnet.bnbchain.org',
            'https://bsc-testnet-rpc.publicnode.com',
            'https://bnb-testnet.g.alchemy.com/public',
            'https://bsc-testnet.infura.io/v3/7a4583d0b3014189bbff7f24582fc5ea'
        ],
        arbitrum_eth: [
            'https://arbitrum-sepolia.drpc.org',
            'https://arbitrum-sepolia-rpc.publicnode.com',
            'https://arb-sepolia.g.alchemy.com/public',
            'https://arbitrum-sepolia.infura.io/v3/7a4583d0b3014189bbff7f24582fc5ea'
        ],
        base_eth: [
            'https://base-sepolia.drpc.org',
            'https://sepolia.base.org',
            'https://base-sepolia-rpc.publicnode.com',
            'https://base-sepolia.g.alchemy.com/public',
            'https://base-sepolia.infura.io/v3/7a4583d0b3014189bbff7f24582fc5ea'
        ],
        polygon_eth: [
            'https://polygon-amoy.drpc.org',
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
    ETH_PAYWAY: ['eth', 'erc20', 'ethereum'],

    // Supported BSC payways
    BSC_PAYWAY: ['bsc', 'bep20'],

    // Supported LTC payway
    LTC_PAYWAY: ['ltc'],

    // Supported Arbitrum payways
    ARBITRUM_PAYWAY: ['arbitrum_eth', 'arbitrum_erc20', 'arbitrum'],

    // Supported Base payways
    BASE_PAYWAY: ['base_eth', 'base_erc20', 'base'],

    // Supported Polygon payways
    POLYGON_PAYWAY: ['polygon_eth', 'polygon_erc20', 'polygon'],

    // --- Native ETH L1->L2 bridge (deposit from Sepolia) ---

    // Supported bridge destinations (source chain is always Sepolia L1)
    BRIDGE_DESTINATIONS: ['base', 'arbitrum'] as string[],

    // Base Sepolia (OP Stack) L1StandardBridge on Sepolia — value taken from viem/chains baseSepolia.contracts
    BASE_SEPOLIA_L1_STANDARD_BRIDGE: '0xfd0Bf71F60660E2f608ed56e1659C450eB113120',

    // Arbitrum Sepolia Delayed Inbox on Sepolia — from the Arbitrum contract-address registry
    ARBITRUM_SEPOLIA_INBOX: '0xaAe29B0366299461418F5324a79Afc425BE5ae21',

    // L2 gas limit credited for finalizing an OP Stack ETH deposit on Base
    OP_DEPOSIT_MIN_GAS_LIMIT: 200000,

    // Fixed L2 gas limit for an Arbitrum retryable ticket that only moves ETH (empty calldata)
    ARBITRUM_RETRYABLE_GAS_LIMIT: 100000n,

    // Safety multiplier applied to the on-chain submission fee and L2 gas-price reads
    ARBITRUM_FEE_BUFFER_FACTOR: 2n,

    // Floor for the Arbitrum L2 gas-price bid (0.1 gwei)
    ARBITRUM_L2_GAS_PRICE_FLOOR: 10n ** 8n,

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

    ERC20_ABI: [
        {
            constant: true,
            inputs: [],
            name: "decimals",
            outputs: [{ name: "", type: "uint8" }],
            type: "function",
        },
        {
            constant: true,
            inputs: [
                { name: "owner", type: "address" },
                { name: "spender", type: "address" }
            ],
            name: "allowance",
            outputs: [{ name: "", type: "uint256" }],
            type: "function",
        },
        {
            constant: false,
            inputs: [
                { name: "spender", type: "address" },
                { name: "amount", type: "uint256" }
            ],
            name: "approve",
            outputs: [{ name: "", type: "bool" }],
            type: "function",
        }
    ] as AbiItem[],

    PUBLIC_MULTI_SEND_V1_ABI: [
        {
            inputs: [
                {
                    components: [
                        { name: "to", type: "address" },
                        { name: "amount", type: "uint256" }
                    ],
                    name: "nativeTransfers",
                    type: "tuple[]"
                },
                {
                    components: [
                        { name: "token", type: "address" },
                        { name: "to", type: "address" },
                        { name: "amount", type: "uint256" }
                    ],
                    name: "tokenTransfers",
                    type: "tuple[]"
                }
            ],
            name: "batchSend",
            outputs: [],
            stateMutability: "payable",
            type: "function"
        }
    ] as AbiItem[],

    // ABI for the OP Stack L1StandardBridge (Base) — native ETH deposits
    L1_STANDARD_BRIDGE_ABI: [
        {
            type: 'function',
            name: 'depositETH',
            stateMutability: 'payable',
            inputs: [
                { name: '_minGasLimit', type: 'uint32' },
                { name: '_extraData', type: 'bytes' }
            ],
            outputs: []
        },
        {
            type: 'function',
            name: 'bridgeETHTo',
            stateMutability: 'payable',
            inputs: [
                { name: '_to', type: 'address' },
                { name: '_minGasLimit', type: 'uint32' },
                { name: '_extraData', type: 'bytes' }
            ],
            outputs: []
        }
    ] as const,

    // ABI for the Arbitrum Delayed Inbox — native ETH deposits
    ARBITRUM_INBOX_ABI: [
        {
            type: 'function',
            name: 'depositEth',
            stateMutability: 'payable',
            inputs: [],
            outputs: [{ name: '', type: 'uint256' }]
        },
        {
            type: 'function',
            name: 'createRetryableTicket',
            stateMutability: 'payable',
            inputs: [
                { name: 'to', type: 'address' },
                { name: 'l2CallValue', type: 'uint256' },
                { name: 'maxSubmissionCost', type: 'uint256' },
                { name: 'excessFeeRefundAddress', type: 'address' },
                { name: 'callValueRefundAddress', type: 'address' },
                { name: 'gasLimit', type: 'uint256' },
                { name: 'maxFeePerGas', type: 'uint256' },
                { name: 'data', type: 'bytes' }
            ],
            outputs: [{ name: '', type: 'uint256' }]
        },
        {
            type: 'function',
            name: 'calculateRetryableSubmissionFee',
            stateMutability: 'view',
            inputs: [
                { name: 'dataLength', type: 'uint256' },
                { name: 'baseFee', type: 'uint256' }
            ],
            outputs: [{ name: '', type: 'uint256' }]
        }
    ] as const,

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
        'typeerror: networkerror',
        'failed to publish transaction to any of the forwarding targets',
        'nonce too low'
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
