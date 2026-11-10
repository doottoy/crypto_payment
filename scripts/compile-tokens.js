/*
 * Compiles contracts/tokens/*.sol with solc-js into src/tokens/artifacts.json (ABI and bytecode per preset).
 * Run it after changing a contract: npm run tokens:compile. The service itself never compiles anything.
 * evmVersion cancun: OpenZeppelin 5.6 needs MCOPY, and every testnet the service pays on runs Cancun since 2024.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const solc = require('solc');

const root = path.join(__dirname, '..');
const contractsDir = path.join(root, 'contracts', 'tokens');
const PRESETS = { standard: 'StandardTestToken', faucet: 'FaucetTestToken', advanced: 'AdvancedTestToken' };
const SETTINGS = {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
};

function tokenSources() {
    return fs.readdirSync(contractsDir).filter((f) => f.endsWith('.sol')).sort()
        .map((file) => ({ key: `contracts/tokens/${file}`, content: fs.readFileSync(path.join(contractsDir, file), 'utf8') }));
}

/** Also recomputed by the unit tests, which fail when artifacts.json is older than the sources */
function sourcesHash(sources) {
    const hash = crypto.createHash('sha256');
    for (const { key, content } of sources) hash.update(`${key}\n${content}\n`);
    return hash.digest('hex');
}

function findImports(importPath) {
    try {
        const resolved = importPath.startsWith('@openzeppelin/')
            ? require.resolve(importPath, { paths: [root] })
            : path.join(root, importPath);
        return { contents: fs.readFileSync(resolved, 'utf8') };
    } catch {
        return { error: `File not found: ${importPath}` };
    }
}

function main() {
    const sources = tokenSources();
    const input = {
        language: 'Solidity',
        sources: Object.fromEntries(sources.map(({ key, content }) => [key, { content }])),
        settings: SETTINGS
    };
    const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

    for (const message of output.errors || []) console.error(message.formattedMessage);
    if ((output.errors || []).some((e) => e.severity === 'error')) process.exit(1);

    const artifacts = {
        compiler: solc.version(),
        openzeppelin: require(require.resolve('@openzeppelin/contracts/package.json', { paths: [root] })).version,
        settings: { optimizer: SETTINGS.optimizer, evmVersion: SETTINGS.evmVersion },
        sourcesHash: sourcesHash(sources),
        presets: {}
    };
    for (const [preset, name] of Object.entries(PRESETS)) {
        const compiled = output.contracts[`contracts/tokens/${name}.sol`][name];
        artifacts.presets[preset] = { contract: name, abi: compiled.abi, bytecode: `0x${compiled.evm.bytecode.object}` };
    }

    const target = path.join(root, 'src', 'tokens', 'artifacts.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(artifacts, null, 2)}\n`);
    for (const [preset, { bytecode }] of Object.entries(artifacts.presets)) {
        console.log(`${preset.padEnd(9)} ${(bytecode.length - 2) / 2} bytes`);
    }
}

module.exports = { sourcesHash, tokenSources };
if (require.main === module) main();
