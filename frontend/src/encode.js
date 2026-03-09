// frontend/src/encode.js
// Binary ABI encoding/decoding for OP_NET. No external dependencies.

export async function selector(sig) {
  const utf8 = new TextEncoder().encode(sig);
  const hash = await crypto.subtle.digest('SHA-256', utf8);
  return new Uint8Array(hash).slice(0, 4);
}

export function encodeU8(v) {
  return new Uint8Array([v & 0xff]);
}

export function encodeU256(bigint) {
  const buf = new Uint8Array(32);
  let n = BigInt(bigint);
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return buf;
}

export function encodeBool(v) {
  return new Uint8Array([v ? 1 : 0]);
}

export function encodeAddress(addr) {
  // addr is a 0x-prefixed hex string (64 hex chars = 32 bytes)
  const hex = addr.startsWith('0x') ? addr.slice(2) : addr;
  const buf = new Uint8Array(32);
  // right-align the address bytes in 32-byte buffer
  const bytes = hex.match(/.{2}/g)?.map(h => parseInt(h, 16)) ?? [];
  const offset = 32 - bytes.length;
  bytes.forEach((b, i) => { buf[offset + i] = b; });
  return buf;
}

export function concat(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

export function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const buf = new Uint8Array(h.length / 2);
  for (let i = 0; i < buf.length; i++) buf[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return buf;
}

// Decoder class
export class Decoder {
  constructor(hexOrBytes) {
    this.buf = typeof hexOrBytes === 'string' ? fromHex(hexOrBytes) : hexOrBytes;
    this.pos = 0;
  }
  readU8() { return this.buf[this.pos++]; }
  readU256() {
    let n = 0n;
    for (let i = 0; i < 32; i++) { n = (n << 8n) | BigInt(this.buf[this.pos++]); }
    return n;
  }
  readBool() { return this.buf[this.pos++] !== 0; }
  readAddress() {
    const bytes = this.buf.slice(this.pos, this.pos + 32);
    this.pos += 32;
    return '0x' + toHex(bytes);
  }
}
