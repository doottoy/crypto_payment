import { config } from 'dotenv';
import { AbiItem } from 'web3-utils';

config();

// Constants
export const Const = {
    // Gas limit for multi-send transactions
    MULTI_SEND_GAS_LIMIT: 1000000,

    // Tron fee limit
    TRON_FEE_LIMIT: 100_000_000,

    // Testnet providers urls
    BSC_TESTNET: 'https://bsc-testnet.publicnode.com',
    ETH_TESTNET: 'https://ethereum-sepolia.publicnode.com',
    ARBITRUM_TESTNET: 'https://arbitrum-sepolia-rpc.publicnode.com',
    BASE_TESTNET: 'https://base-sepolia-rpc.publicnode.com',
    SOLANA_DEVNET: 'https://api.devnet.solana.com',
    TRON_NILE: 'https://nile.trongrid.io',

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
        NILE_TRON: 'https://nile.tronscan.org/#/transaction/'
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
    APPLICATION_JSON: 'application/json' as string
};
