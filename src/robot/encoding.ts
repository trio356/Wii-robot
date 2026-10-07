/**
 * Minimal base64 for the BLE wire. Payloads are short ASCII JSON, so a
 * UTF-16-safe full encoder is unnecessary — but non-ASCII is rejected loudly
 * instead of being silently mangled.
 */

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64Ascii(input: string): string {
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) > 255) {
      throw new Error('[robot] base64: non-Latin1 payload, refusing to mangle');
    }
  }
  let out = '';
  for (let i = 0; i < input.length; i += 3) {
    const a = input.charCodeAt(i);
    const b = i + 1 < input.length ? input.charCodeAt(i + 1) : 0;
    const c = i + 2 < input.length ? input.charCodeAt(i + 2) : 0;
    const n = (a << 16) | (b << 8) | c;
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    out += i + 1 < input.length ? ALPHABET[(n >> 6) & 63] : '=';
    out += i + 2 < input.length ? ALPHABET[n & 63] : '=';
  }
  return out;
}

export function fromBase64Ascii(input: string): string {
  const clean = input.replace(/\s/g, '');
  const rev = new Map<string, number>();
  for (let i = 0; i < ALPHABET.length; i++) rev.set(ALPHABET[i], i);
  let bits = 0;
  let nbits = 0;
  let out = '';
  for (const ch of clean) {
    if (ch === '=') break;
    const v = rev.get(ch);
    if (v === undefined) throw new Error('[robot] base64: invalid character');
    bits = (bits << 6) | v;
    nbits += 6;
    if (nbits >= 8) {
      nbits -= 8;
      out += String.fromCharCode((bits >> nbits) & 0xff);
    }
  }
  return out;
}
