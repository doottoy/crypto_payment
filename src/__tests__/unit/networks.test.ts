import 'mocha';
import { expect } from 'chai';

import { Const } from '../../constants/const';
import { getChainForPayway } from '../../utils/evm';
import { notifierMessage } from '../../utils/message-formatter';
import { evmPayways, findEvmNetwork } from '../../networks/evm-networks';
import { getEvmRpcUrlsForPayway, modules } from '../../utils/modules';

/*
 * The expected values below are the old if/else chains of utils/evm.ts, utils/modules.ts and
 * utils/message-formatter.ts written out, so the registry provably maps every existing payway the same way.
 */
const BEFORE = [
    { payways: ['eth', 'erc20', 'ethereum'], chainId: 11155111, rpc: 'eth', legacy: Const.ETH_TESTNET, explorer: Const.TESTNET_EXPLORER.ETH },
    { payways: ['bsc', 'bep20'], chainId: 97, rpc: 'bsc', legacy: Const.BSC_TESTNET, explorer: Const.TESTNET_EXPLORER.BSC },
    { payways: ['arbitrum_eth', 'arbitrum_erc20', 'arbitrum'], chainId: 421614, rpc: 'arbitrum_eth', legacy: Const.ARBITRUM_TESTNET, explorer: Const.TESTNET_EXPLORER.ARBITRUM },
    { payways: ['base_eth', 'base_erc20', 'base'], chainId: 84532, rpc: 'base_eth', legacy: Const.BASE_TESTNET, explorer: Const.TESTNET_EXPLORER.BASE },
    { payways: ['polygon_eth', 'polygon_erc20', 'polygon'], chainId: 80002, rpc: 'polygon_eth', legacy: Const.AMOY_POLYGON, explorer: Const.TESTNET_EXPLORER.POLYGON }
];

function explorerIn(payway: string): string {
    return notifierMessage.formatSuccessEVMTransaction(payway, 'ETH', { transactionHash: '0xHASH', from: '0xFROM' }).split('View in explorer: ')[1];
}

describe('EVM network registry', () => {
    it('maps every existing payway exactly as the old if/else chains did', async () => {
        for (const network of BEFORE) {
            for (const payway of network.payways) {
                expect(getChainForPayway(payway).id, payway).to.equal(network.chainId);
                expect(getEvmRpcUrlsForPayway(payway), payway).to.equal(Const.EVM_RPC_PROVIDERS[network.rpc]);
                expect(await modules.getRpcUrl(payway), payway).to.equal(network.legacy);
                expect(explorerIn(payway), payway).to.equal(`${network.explorer}0xHASH`);
            }
        }
    });

    it('keeps the old fallbacks for unknown payways', async () => {
        expect(() => getChainForPayway('dogecoin')).to.throw('Unsupported payway for chain mapping: dogecoin');
        expect(() => getEvmRpcUrlsForPayway('dogecoin')).to.throw('Unknown EVM payway: dogecoin');
        expect(await modules.getRpcUrl('dogecoin')).to.equal(Const.ETH_TESTNET);
        expect(explorerIn('dogecoin')).to.equal(`${Const.TESTNET_EXPLORER.ETH}0xHASH`);
    });

    it('adds OP Sepolia under op_eth, op_erc20 and optimism', () => {
        for (const payway of ['op_eth', 'op_erc20', 'optimism']) {
            expect(getChainForPayway(payway).id).to.equal(11155420);
            expect(getEvmRpcUrlsForPayway(payway)).to.equal(Const.EVM_RPC_PROVIDERS.op_eth);
            expect(explorerIn(payway)).to.equal(`${Const.TESTNET_EXPLORER.OPTIMISM}0xHASH`);
            expect(Const.EVM_FEE.TIP_FLOORS[payway]).to.equal(10n ** 8n);
        }
        expect(Const.EVM_RPC_PROVIDERS.op_eth.length).to.be.greaterThan(0);
    });

    it('lists each payway once and resolves it case-insensitively', () => {
        const all = evmPayways();

        expect(new Set(all).size).to.equal(all.length);
        expect(findEvmNetwork('BASE_ETH')?.rpcKey).to.equal('base_eth');
    });

    it('bridges to OP Stack destinations through their L1StandardBridge', () => {
        expect(Const.BRIDGE_DESTINATIONS).to.include.members(['base', 'arbitrum', 'optimism']);
        expect(Const.OP_STACK_L1_STANDARD_BRIDGES.base).to.equal(Const.BASE_SEPOLIA_L1_STANDARD_BRIDGE);
        expect(Const.OP_STACK_L1_STANDARD_BRIDGES.optimism).to.equal(Const.OPTIMISM_SEPOLIA_L1_STANDARD_BRIDGE);
    });
});
