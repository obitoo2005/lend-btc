/**
 * LendBTC — Admin Setup Script
 *
 * Calls the admin-only contract methods after deployment:
 *   1. setTokenAddresses(MOTO, PILL)
 *   2. setPrice(BTC,  price_in_sats)
 *   3. setPrice(MOTO, price_in_sats)
 *   4. setPrice(PILL, price_in_sats)
 *
 * Usage:
 *   node setup.mjs --wif YOUR_WIF_KEY
 *
 * Edit the CONFIG block below before running.
 */

import { networks }         from './node_modules/@btc-vision/bitcoin/build/index.js';
import { JSONRpcProvider }  from './node_modules/opnet/build/index.js';
import {
    EcKeyPair,
    InteractionTransaction,
    Address,
} from './node_modules/@btc-vision/transaction/build/index.js';
import { QuantumBIP32Factory, MLDSASecurityLevel } from './node_modules/@btc-vision/bip32/src/esm/quantum/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// ★ EDIT THIS BLOCK ★
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = {
    // Your deployed LendBTC contract address (from deployed.json or OPWallet)
    CONTRACT:  'opt1sqru0uq56ln39kxvnfexscfcq4uvvwjalqsna5vu8',

    // MOTO OP-20 contract address
    MOTO_ADDR: 'opt1sqzkx6wm5acawl9m6nay2mjsm6wagv7gazcgtczds',

    // PILL OP-20 contract address — paste when you have it, or leave as MOTO for now
    PILL_ADDR: 'opt1sqp5gx9k0nrqph3sy3aeyzt673dz7ygtqxcfdqfle',

    // Prices in satoshis × 10^8 scale (price = usd_price * 100_000_000n * 100_000_000n / btc_usd)
    // Simpler: just put the USD price in cents * 10^8
    // BTC  = $97,000  → 9700000000000n  (97000 * 10^8)
    // MOTO = $0.842   → 84200000n       (0.842 * 10^8)
    // PILL = $0.124   → 12400000n       (0.124 * 10^8)
    BTC_PRICE_SATS:  9700000000000n,
    MOTO_PRICE_SATS: 84200000n,
    PILL_PRICE_SATS: 12400000n,

    // Network
    NETWORK: 'testnet',
    RPC_URL: 'https://testnet.opnet.org',
};

// ─────────────────────────────────────────────────────────────────────────────
// ABI ENCODING  (matches btc-runtime BinaryWriter format)
// ─────────────────────────────────────────────────────────────────────────────

async function selector(sig) {
    const buf  = new TextEncoder().encode(sig);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return new Uint8Array(hash).slice(0, 4);
}

function encodeU8(v) {
    return new Uint8Array([v & 0xff]);
}

function encodeU256(n) {
    const buf = new Uint8Array(32);
    let val = BigInt(n);
    for (let i = 31; i >= 0; i--) { buf[i] = Number(val & 0xffn); val >>= 8n; }
    return buf;
}

function encodeAddress(addr) {
    // OP_NET address → 32 bytes
    // The contract reads address as 32 bytes from calldata
    const addrObj = new Address(addr);
    const buf = addrObj.originalPublicKeyBuffer?.() ?? addrObj.toBuffer?.() ?? new Uint8Array(32);
    const out = new Uint8Array(32);
    out.set(buf.slice(0, 32));
    return out;
}

function concat(...arrays) {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) { out.set(a, off); off += a.length; }
    return out;
}

async function buildCalldata(sig, ...params) {
    const sel = await selector(sig);
    const args = params.length ? concat(...params) : new Uint8Array(0);
    return concat(sel, args);
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND ONE INTERACTION
// ─────────────────────────────────────────────────────────────────────────────

async function sendInteraction(provider, signer, mldsaSigner, network, calldata, label) {
    process.stdout.write(`  ${label}... `);

    // Get fresh UTXOs each time (previous tx may have consumed some)
    const deployerAddress = EcKeyPair.getP2WPKHAddress(signer, network);
    const res = await provider.utxoManager.getUTXOsForAmount({
        address:           deployerAddress,
        amount:            50_000n,
        optimize:          true,
        mergePendingUTXOs: false,
        filterSpentUTXOs:  true,
    });
    const utxos = Array.isArray(res) ? res : (res.utxos ?? []);
    if (!utxos.length) throw new Error('No UTXOs — wait for previous tx to confirm');

    const challenge = await provider.getChallenge();

    // InteractionTransaction requires the 32-byte contract secret (pubkey of contract)
    // For OP_NET, this is derived from the contract address
    const contractObj = new Address(CONFIG.CONTRACT);
    const contractSecret = contractObj.originalPublicKeyBuffer?.() ??
                           contractObj.toBuffer?.() ??
                           new Uint8Array(32);

    const tx = new InteractionTransaction({
        signer,
        mldsaSigner,
        network,
        utxos,
        challenge,
        calldata,
        to:          CONFIG.CONTRACT,
        contract:    Buffer.from(contractSecret).toString('hex').padStart(64, '0'),
        feeRate:     20,
        priorityFee: 5_000n,
        gasSatFee:   5_000n,
    });

    const signed = await tx.signTransaction();
    const txHex  = signed.toHex();
    const psbt   = tx.transaction?.toHex?.() ?? '';
    const result = await provider.sendRawTransaction(txHex, psbt);
    const txid   = result?.txid ?? result?.hash ?? JSON.stringify(result);
    console.log(`✓  txid: ${txid}`);
    return txid;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
    const wif = process.argv[process.argv.indexOf('--wif') + 1];
    if (!wif) {
        console.error('Usage: node setup.mjs --wif YOUR_WIF_KEY');
        process.exit(1);
    }

    if (CONFIG.PILL_ADDR === 'PASTE_PILL_ADDRESS_HERE') {
        console.error('\n❌  Set PILL_ADDR in the CONFIG block at the top of setup.mjs');
        console.error('    If you have no PILL token yet, set it to the same as MOTO_ADDR temporarily.\n');
        process.exit(1);
    }

    console.log('\n  LendBTC Admin Setup');
    console.log('  ═══════════════════════════════════');
    console.log(`  Contract : ${CONFIG.CONTRACT}`);
    console.log(`  MOTO     : ${CONFIG.MOTO_ADDR}`);
    console.log(`  PILL     : ${CONFIG.PILL_ADDR}`);
    console.log(`  Network  : ${CONFIG.NETWORK}\n`);

    const network = networks[CONFIG.NETWORK];
    const signer  = EcKeyPair.fromWIF(wif, network);
    const mldsaSigner = QuantumBIP32Factory.fromSeed(
        Buffer.from(signer.privateKey), MLDSASecurityLevel.LEVEL2, network,
    );

    const provider = new JSONRpcProvider({
        url: CONFIG.RPC_URL, network: CONFIG.NETWORK,
        timeout: 30_000, useThreadedHttp: false, useThreadedParsing: false,
    });

    console.log('Sending admin transactions:\n');

    // 1. setTokenAddresses(moto, pill)
    const cd1 = await buildCalldata(
        'setTokenAddresses(address,address)',
        encodeAddress(CONFIG.MOTO_ADDR),
        encodeAddress(CONFIG.PILL_ADDR),
    );
    await sendInteraction(provider, signer, mldsaSigner, network, cd1, 'setTokenAddresses');

    // 2. setPrice(0 = BTC,  price)
    const cd2 = await buildCalldata('setPrice(uint8,uint256)',
        encodeU8(0), encodeU256(CONFIG.BTC_PRICE_SATS));
    await sendInteraction(provider, signer, mldsaSigner, network, cd2, 'setPrice BTC');

    // 3. setPrice(1 = MOTO, price)
    const cd3 = await buildCalldata('setPrice(uint8,uint256)',
        encodeU8(1), encodeU256(CONFIG.MOTO_PRICE_SATS));
    await sendInteraction(provider, signer, mldsaSigner, network, cd3, 'setPrice MOTO');

    // 4. setPrice(2 = PILL, price)
    const cd4 = await buildCalldata('setPrice(uint8,uint256)',
        encodeU8(2), encodeU256(CONFIG.PILL_PRICE_SATS));
    await sendInteraction(provider, signer, mldsaSigner, network, cd4, 'setPrice PILL');

    console.log('\n  ✅  Setup complete!');
    console.log('  Wait ~10 min for all txs to confirm, then open frontend/index.html');
    console.log('  Track at: https://opscan.org\n');
}

main().catch(e => { console.error('\n❌', e.message); process.exit(1); });
