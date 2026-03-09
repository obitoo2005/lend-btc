/**
 * LendBTC — OP_NET Deployment Script
 *
 * Usage:
 *   node deploy.mjs --wif YOUR_WIF_KEY [--network testnet|regtest|mainnet]
 *
 * Example (testnet):
 *   node deploy.mjs --wif cNxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx --network testnet
 *
 * How to get your WIF key from OPWallet:
 *   OPWallet → Settings → Wallet → Export Private Key → copy WIF
 *
 * After running, your contract address is printed and saved to deployed.json
 */

import { readFileSync, writeFileSync } from 'fs';

// ── SDK imports ───────────────────────────────────────────────────────────────
import { JSONRpcProvider }  from './node_modules/opnet/build/index.js';
import { networks }         from './node_modules/@btc-vision/bitcoin/build/index.js';
import {
    EcKeyPair,
    DeploymentTransaction,
} from './node_modules/@btc-vision/transaction/build/index.js';
import {
    QuantumBIP32Factory,
    MLDSASecurityLevel,
} from './node_modules/@btc-vision/bip32/src/esm/quantum/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const RPC_URLS = {
    mainnet:  'https://api.opnet.org',
    testnet:  'https://testnet.opnet.org',
    regtest:  'https://regtest.opnet.org',
};

const BITCOIN_NETWORKS = {
    mainnet:  networks.bitcoin,
    testnet:  networks.testnet,
    regtest:  networks.regtest,
    opnetTestnet: networks.opnetTestnet,
};

// ─────────────────────────────────────────────────────────────────────────────
// PARSE ARGS
// ─────────────────────────────────────────────────────────────────────────────
function parseArgs() {
    const args = process.argv.slice(2);
    const get  = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

    const wif     = get('--wif');
    const netName = get('--network') ?? 'testnet';
    const rpc     = get('--rpc')     ?? RPC_URLS[netName];

    if (!wif) {
        console.error('\n❌  Missing --wif flag\n');
        console.error('Usage:');
        console.error('  node deploy.mjs --wif YOUR_WIF_PRIVATE_KEY --network testnet');
        console.error('');
        console.error('How to find your WIF key:');
        console.error('  OPWallet → Settings → Wallet → Export Private Key');
        console.error('  (testnet WIF keys start with "c", mainnet start with "K" or "L" or "5")');
        process.exit(1);
    }

    if (!BITCOIN_NETWORKS[netName]) {
        console.error(`\n❌  Unknown network "${netName}". Use: testnet | regtest | mainnet\n`);
        process.exit(1);
    }

    return { wif, netName, rpc, network: BITCOIN_NETWORKS[netName] };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
    const { wif, netName, rpc, network } = parseArgs();

    console.log('\n  LendBTC OP_NET Deployer');
    console.log('  ════════════════════════');
    console.log(`  Network : ${netName}`);
    console.log(`  RPC URL : ${rpc}\n`);

    // ── Step 1: Load EC keypair from WIF ─────────────────────────────────────
    process.stdout.write('1/7  Loading keypair from WIF... ');
    let signer;
    try {
        signer = EcKeyPair.fromWIF(wif, network);
    } catch (e) {
        console.error(`\n❌  Bad WIF key: ${e.message}`);
        console.error('    Make sure you copied the full WIF key and are using the right --network flag.');
        process.exit(1);
    }

    const deployerAddress = EcKeyPair.getP2WPKHAddress(signer, network);
    console.log('done');
    console.log(`     Address: ${deployerAddress}`);

    // ── Step 2: Derive MLDSA post-quantum key ─────────────────────────────────
    // OP_NET requires MLDSA (post-quantum) signing for all transactions.
    // We derive it deterministically from the same private key — no extra key needed.
    process.stdout.write('2/7  Deriving MLDSA post-quantum key... ');
    const privKeyBytes = signer.privateKey;
    if (!privKeyBytes || privKeyBytes.length !== 32) {
        console.error('\n❌  Could not extract 32-byte private key');
        process.exit(1);
    }
    let mldsaSigner;
    try {
        mldsaSigner = QuantumBIP32Factory.fromSeed(
            Buffer.from(privKeyBytes),
            MLDSASecurityLevel.LEVEL2,  // LEVEL2 = ML-DSA-44 (smallest/fastest)
            network,
        );
    } catch (e) {
        console.error(`\n❌  MLDSA key derivation failed: ${e.message}`);
        process.exit(1);
    }
    console.log('done');

    // ── Step 3: Connect to RPC ────────────────────────────────────────────────
    process.stdout.write('3/7  Connecting to OP_NET RPC... ');
    const provider = new JSONRpcProvider({
        url:                rpc,
        network:            netName,
        timeout:            30_000,
        useThreadedHttp:    false,
        useThreadedParsing: false,
    });
    try {
        const blockNum = await provider.getBlockNumber();
        console.log(`done  (block ${blockNum})`);
    } catch (e) {
        console.error(`\n❌  RPC unreachable: ${e.message}`);
        console.error(`    Check that ${rpc} is accessible.`);
        process.exit(1);
    }

    // ── Step 4: Check balance ─────────────────────────────────────────────────
    process.stdout.write('4/7  Checking wallet balance... ');
    try {
        const bal = await provider.getBalance(deployerAddress);
        const confirmed = typeof bal === 'bigint' ? bal : BigInt(bal.confirmed ?? 0);
        const btcStr = (Number(confirmed) / 1e8).toFixed(8);
        console.log(`done  (${btcStr} tBTC confirmed)`);
        if (confirmed < 10_000n) {
            console.error('\n❌  Not enough funds. Need at least 0.0001 tBTC for deployment gas.');
            console.error(`    Fund your address: ${deployerAddress}`);
            if (netName === 'testnet') console.error('    Testnet faucet: https://bitcoinfaucet.uo1.net/');
            process.exit(1);
        }
    } catch (e) {
        console.warn(`skipped (${e.message})`);
    }

    // ── Step 5: Fetch UTXOs ───────────────────────────────────────────────────
    process.stdout.write('5/7  Fetching UTXOs... ');
    let utxos;
    try {
        const res = await provider.utxoManager.getUTXOsForAmount({
            address:            deployerAddress,
            amount:             200_000n,  // ask for enough to cover fees
            optimize:           true,
            mergePendingUTXOs:  false,
            filterSpentUTXOs:   true,
        });
        utxos = Array.isArray(res) ? res : (res.utxos ?? []);
        console.log(`done  (${utxos.length} UTXOs)`);
        if (!utxos.length) {
            console.error('\n❌  No UTXOs found.');
            console.error(`    Send testnet BTC to: ${deployerAddress}`);
            if (netName === 'testnet') console.error('    Faucet: https://bitcoinfaucet.uo1.net/');
            process.exit(1);
        }
    } catch (e) {
        console.error(`\n❌  UTXO fetch failed: ${e.message}`);
        process.exit(1);
    }

    // ── Step 6: Get epoch challenge ───────────────────────────────────────────
    process.stdout.write('6/7  Fetching OP_NET epoch challenge... ');
    let challenge;
    try {
        challenge = await provider.getChallenge();
        console.log(`done  (epoch #${challenge.epochNumber})`);
    } catch (e) {
        console.error(`\n❌  Epoch challenge failed: ${e.message}`);
        console.error('    OP_NET may not be active on this network yet.');
        process.exit(1);
    }

    // ── Step 7: Build, sign, broadcast ───────────────────────────────────────
    process.stdout.write('7/7  Building deployment transaction... ');
    let deployTx;
    try {
        deployTx = new DeploymentTransaction({
            signer,
            mldsaSigner,
            network,
            utxos,
            challenge,
            bytecode:    new Uint8Array(readFileSync('./build/LendBTC.wasm')),
            feeRate:     20,        // sat/vbyte — higher = faster confirmation
            priorityFee: 10_000n,   // OP_NET priority fee in sats
            gasSatFee:   10_000n,   // OP_NET gas fee in sats
        });
    } catch (e) {
        console.error(`\n❌  Failed to build tx: ${e.message}\n${e.stack}`);
        process.exit(1);
    }

    const contractAddress = deployTx.contractAddress.p2op(network);
    console.log('done');
    console.log(`\n     ┌─────────────────────────────────────────────────────────┐`);
    console.log(`     │  Contract address: ${contractAddress.padEnd(37)}│`);
    console.log(`     └─────────────────────────────────────────────────────────┘`);

    process.stdout.write('     Signing... ');
    let signedTx;
    try {
        signedTx = await deployTx.signTransaction();
        console.log('done');
    } catch (e) {
        console.error(`\n❌  Signing failed: ${e.message}`);
        process.exit(1);
    }

    process.stdout.write('     Broadcasting... ');
    try {
        const txHex  = signedTx.toHex();
        const psbtHex = deployTx.transaction?.toHex?.() ?? '';
        const result  = await provider.sendRawTransaction(txHex, psbtHex);
        const txid    = result?.txid ?? result?.hash ?? JSON.stringify(result);
        console.log('done');

        // ── SUCCESS ───────────────────────────────────────────────────────────
        const explorerBase = netName === 'mainnet' ? 'https://opnet.org' : `https://${netName}.opnet.org`;

        console.log('\n');
        console.log('  ✅  CONTRACT DEPLOYED SUCCESSFULLY!');
        console.log('  ══════════════════════════════════════════════════════════════');
        console.log(`  Contract Address : ${contractAddress}`);
        console.log(`  Transaction ID   : ${txid}`);
        console.log(`  Explorer         : ${explorerBase}/tx/${txid}`);
        console.log('');
        console.log('  NEXT STEPS:');
        console.log('  ──────────────────────────────────────────────────────────────');
        console.log('  1. Copy your contract address above');
        console.log('  2. Edit frontend/src/config.js:');
        console.log(`       CONTRACT_ADDRESS = '${contractAddress}'`);
        console.log(`       RPC_URL          = '${rpc}'`);
        console.log('  3. Rebuild the SDK bundle:');
        console.log('       node frontend/build.mjs');
        console.log('  4. Set up the contract (admin calls via OPWallet):');
        console.log('       - setTokenAddresses(MOTO_ADDR, PILL_ADDR)');
        console.log('       - setPrice(0, BTC_PRICE_IN_SATS)');
        console.log('       - setPrice(1, MOTO_PRICE_IN_SATS)');
        console.log('       - setPrice(2, PILL_PRICE_IN_SATS)');
        console.log('  5. Open frontend/index.html in browser with OPWallet installed');
        console.log('');

        // Save to deployed.json
        const out = {
            contractAddress,
            txid,
            network:    netName,
            rpcUrl:     rpc,
            deployedAt: new Date().toISOString(),
        };
        writeFileSync('./deployed.json', JSON.stringify(out, null, 2));
        console.log('  📄  Saved to deployed.json');
        console.log('');

        // Auto-patch frontend/src/config.js
        try {
            let cfg = readFileSync('./frontend/src/config.js', 'utf8');
            cfg = cfg.replace(
                /export const CONTRACT_ADDRESS\s*=\s*['"][^'"]*['"]/,
                `export const CONTRACT_ADDRESS = '${contractAddress}'`
            ).replace(
                /export const RPC_URL\s*=\s*['"][^'"]*['"]/,
                `export const RPC_URL = '${rpc}'`
            );
            writeFileSync('./frontend/src/config.js', cfg);
            console.log('  ✅  frontend/src/config.js updated automatically!');
            console.log('  Run:  node frontend/build.mjs   then open frontend/index.html');
            console.log('');
        } catch (_) { /* config.js patch is optional */ }

    } catch (e) {
        console.error(`\n❌  Broadcast failed: ${e.message}`);
        process.exit(1);
    }
}

main().catch(e => { console.error('\nFatal:', e); process.exit(1); });
