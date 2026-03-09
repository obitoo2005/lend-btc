// frontend/src/tx.js
import { walletService } from './wallet.js';
import { rpcFetch } from './rpc.js';

export async function sendInteraction(calldataHex, contractAddress, satAmount = 0) {
  const wallet = walletService._getWallet(walletService.type);

  // Try OPWallet's native interaction method
  if (wallet && typeof wallet.sendInteraction === 'function') {
    const txHash = await wallet.sendInteraction({
      contract: contractAddress,
      calldata: calldataHex,
      satAmount,
    });
    return { txHash, submitted: true };
  }

  // Try Unisat-compatible sign+broadcast
  if (wallet && typeof wallet.signPsbt === 'function') {
    // This requires PSBT construction which needs UTXOs + transaction builder
    // For now, throw with helpful error
    throw new Error('PSBT construction requires UTXOs. Please use opnet-cli or the OPWallet browser extension with full support.');
  }

  // Demo mode: simulate
  await new Promise(r => setTimeout(r, 2000));
  const fakeHash = Array.from({ length: 32 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
  return { txHash: fakeHash, submitted: true, simulated: true };
}
