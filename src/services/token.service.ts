/* External dependencies */
import { encodeDeployData, encodeFunctionData, parseUnits, type Abi, type Address, type Hex } from 'viem';

/* Internal dependencies */
import { logger } from '../utils/logger';
import { modules } from '../utils/modules';
import { findEvmNetwork } from '../networks/evm-networks';
import { EvmContractService } from './evm.contract.service';

/* Compiled by `npm run tokens:compile` from contracts/tokens; nothing is compiled at runtime */
import artifacts from '../tokens/artifacts.json';

export type TokenPreset = 'standard' | 'faucet' | 'advanced';

export const TOKEN_PRESETS: readonly TokenPreset[] = ['standard', 'faucet', 'advanced'];

export interface DeployTokenInput {
    payway: string;
    privateKey: string;
    preset: TokenPreset;
    name: string;
    symbol: string;
    decimals: number;
    /** human units minted to the owner at deploy */
    initialSupply: string;
    owner?: Address;
    /** faucet preset: human units per claim */
    faucetAmount?: string;
    /** faucet preset: seconds between claims of one address */
    faucetCooldown?: number;
    requestId?: string;
}

export interface DeployedToken {
    txId: Hex;
    contractAddress: Address;
    owner: Address;
}

function presetArtifact(preset: TokenPreset): { abi: Abi; bytecode: Hex } {
    const artifact = (artifacts.presets as Record<string, { abi: unknown; bytecode: string }>)[preset];
    return { abi: artifact.abi as Abi, bytecode: artifact.bytecode as Hex };
}

function explorerLink(payway: string, hash: string): string {
    const prefix = findEvmNetwork(payway)?.explorerTx;
    return prefix ? `${prefix}${hash}` : hash;
}

/** The constructor arguments of a preset, amounts already in base units */
export function constructorArgs(input: DeployTokenInput, owner: Address): unknown[] {
    const base = [input.name, input.symbol, input.decimals, parseUnits(input.initialSupply, input.decimals), owner];
    if (input.preset !== 'faucet') return base;
    return [...base, parseUnits(input.faucetAmount ?? '0', input.decimals), BigInt(input.faucetCooldown ?? 86400)];
}

export async function deployToken(input: DeployTokenInput): Promise<DeployedToken> {
    const service = new EvmContractService(input.payway, input.privateKey);
    await service.init();

    const owner = input.owner ?? service.senderAddress;
    const { abi, bytecode } = presetArtifact(input.preset);
    const data = encodeDeployData({ abi, bytecode, args: constructorArgs(input, owner) });

    const { txHash, receipt } = await service.sendAndConfirm({ data, label: 'TOKEN_DEPLOY', requestId: input.requestId });
    if (!receipt.contractAddress) {
        throw new Error(`Deploy transaction ${txHash} has no contract address in its receipt`);
    }

    logger.info(input.payway.toUpperCase(), `🪙[TOKEN_DEPLOYED][${input.preset}][${input.symbol}][ADDRESS:${receipt.contractAddress}][HASH:${txHash}]`);
    await modules.sendMessageToTelegram(`🪙 Type: Token deployed
🌐 Blockchain: ${input.payway.toUpperCase()}
🧩 Preset: ${input.preset}
💸 Token: ${input.name} (${input.symbol}), ${input.decimals} decimals
📍 Address: ${receipt.contractAddress}
👤 Owner: ${owner}
🔍 View in explorer: ${explorerLink(input.payway, txHash)}${input.requestId ? `\n🧾 Request ID: ${input.requestId}` : ''}`);

    return { txId: txHash, contractAddress: receipt.contractAddress, owner };
}

/** Address of the contract a journaled deploy created, for request_id replays */
export async function deployedAddressOf(payway: string, privateKey: string, txId: Hex): Promise<Address | null> {
    const service = new EvmContractService(payway, privateKey);
    await service.init();
    return (await service.receiptOf(txId)).contractAddress ?? null;
}

export async function mintToken(input: { payway: string; privateKey: string; contract: Address; to: Address; amount: string; requestId?: string }): Promise<Hex> {
    const service = new EvmContractService(input.payway, input.privateKey);
    await service.init();

    const { abi } = presetArtifact('standard');
    const decimals = Number(await service.read<number>(input.contract, abi, 'decimals'));
    const data = encodeFunctionData({ abi, functionName: 'mint', args: [input.to, parseUnits(input.amount, decimals)] });

    const { txHash } = await service.sendAndConfirm({ to: input.contract, data, label: 'TOKEN_MINT', requestId: input.requestId });
    logger.info(input.payway.toUpperCase(), `🪙[TOKEN_MINTED][CONTRACT:${input.contract}][TO:${input.to}][AMOUNT:${input.amount}][HASH:${txHash}]`);
    await modules.sendMessageToTelegram(`🪙 Type: Token minted
🌐 Blockchain: ${input.payway.toUpperCase()}
📍 Token: ${input.contract}
👤 To: ${input.to}
💰 Amount: ${input.amount}
🔍 View in explorer: ${explorerLink(input.payway, txHash)}${input.requestId ? `\n🧾 Request ID: ${input.requestId}` : ''}`);
    return txHash;
}
