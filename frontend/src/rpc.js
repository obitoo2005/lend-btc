// frontend/src/rpc.js
// Direct JSON-RPC over fetch. No SDK dependencies.
import { RPC_URL } from './config.js';

let _id = 1;

export async function rpcFetch(method, params) {
  const resp = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: _id++, method, params }),
  });
  const json = await resp.json();
  if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
  return json.result;
}

// Call a contract view function. Returns the result hex string.
// calldataHex = 4-byte selector + encoded params, as hex string
export async function callContract(contractAddress, calldataHex, fromAddress) {
  return rpcFetch('btc_call', [
    contractAddress,
    calldataHex,
    fromAddress ?? null,
    null, // legacy from
    null, // height
    null, // simulated tx
    null, // access list
  ]);
}

export async function getBalance(address) {
  return rpcFetch('btc_getBalance', [address]);
}

export async function sendRawTransaction(txHex, psbtHex) {
  return rpcFetch('btc_sendRawTransaction', [txHex, psbtHex]);
}

export async function getBlockNumber() {
  return rpcFetch('btc_blockNumber', []);
}
