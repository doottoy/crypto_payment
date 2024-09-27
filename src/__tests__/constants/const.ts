// Constants for __tests__
export const ConstTest = {
    TAB: 4 as number,
    LTC: 'ltc' as string,
    TAG: 'tag' as string,
    POST: 'POST' as string,
    MULTI: 'multi' as string,
    CONFIRMATION: 15 as number,
    SINGLE: 'single' as string,
    CHANGED: '[CHANGED]' as string,
    PRIVATE_KEY: 'privateKey' as string,
    APPLICATION_JSON: 'application/json' as string,
    PATH_FOR_TEST_DATA: './src/__tests__/test-data/' as string,

    // RPC Method
    RPC_METHOD: {
        GET_RAW_TRANSACTION: 'getrawtransaction' as string
    },

    // EVM supported payway
    EVM_PAYWAY: [
        'bsc',
        'bep20',
        'eth',
        'erc20',
        'arbitrum_eth',
        'arbitrum_erc20',
        'base_eth',
        'base_erc20'
    ]
};
