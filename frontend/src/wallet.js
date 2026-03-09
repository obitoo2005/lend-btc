// frontend/src/wallet.js

export const WalletType = { OPWALLET: 'opwallet', UNISAT: 'unisat', NONE: 'none' };

export class WalletService {
  constructor() {
    this.type = WalletType.NONE;
    this.address = null;
    this.publicKey = null;
    this.network = null;
    this._listeners = {};
  }

  get isConnected() { return !!this.address; }

  // Detect available wallets
  detectWallets() {
    return {
      opwallet: typeof window.opnet !== 'undefined' || typeof window.bitcoin !== 'undefined',
      unisat: typeof window.unisat !== 'undefined',
    };
  }

  // Get the wallet provider object
  _getWallet(type) {
    if (type === WalletType.OPWALLET) return window.opnet ?? window.bitcoin ?? null;
    if (type === WalletType.UNISAT) return window.unisat ?? null;
    return null;
  }

  async connect(type) {
    const wallet = this._getWallet(type);
    if (!wallet) {
      // Demo mode: simulate connection
      this.type = type;
      this.address = 'bc1q4xfcvl5j7kqrm9xdlw2eph4rjnhef5gxtzpsm';
      this.publicKey = '02' + '00'.repeat(32);
      this.network = 'regtest';
      this.emit('connect', { address: this.address });
      return { address: this.address, network: this.network };
    }
    const accounts = await wallet.requestAccounts();
    this.address = accounts[0];
    this.publicKey = await wallet.getPublicKey();
    this.network = await wallet.getNetwork();
    this.type = type;
    this.emit('connect', { address: this.address });
    return { address: this.address, network: this.network };
  }

  disconnect() {
    this.type = WalletType.NONE;
    this.address = null;
    this.publicKey = null;
    this.emit('disconnect', {});
  }

  async getBalance() {
    const wallet = this._getWallet(this.type);
    if (!wallet) return { confirmed: 0, unconfirmed: 0, total: 0 };
    try {
      return await wallet.getBalance();
    } catch { return { confirmed: 0, unconfirmed: 0, total: 0 }; }
  }

  // Sign a PSBT — returns signed PSBT hex
  async signPsbt(psbtHex, toSignInputs) {
    const wallet = this._getWallet(this.type);
    if (!wallet) throw new Error('Wallet not connected');
    return wallet.signPsbt(psbtHex, {
      autoFinalized: false,
      toSignInputs: toSignInputs ?? [],
    });
  }

  // Emit events
  on(event, fn) { (this._listeners[event] ??= []).push(fn); }
  emit(event, data) { (this._listeners[event] ?? []).forEach(fn => fn(data)); }
}

export const walletService = new WalletService();
