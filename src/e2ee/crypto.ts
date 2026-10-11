// outpost-e2ee — crypto primitives. Zero dependencies: Bun/Node WebCrypto only.
// X25519 for Diffie-Hellman, HKDF-SHA256 for key derivation, AES-256-GCM
// for message encryption. Ed25519 is NOT available in this WebCrypto, so the
// design is X25519-only: identity keys are X25519 and prekey authenticity
// comes from authenticated registration (provision token), not signatures.
// Documented in README under "Threat model".

const te = new TextEncoder();

export type Bytes = Uint8Array;

export function randomBytes(n: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function b64uEncode(b: Bytes): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(s: string): Bytes {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function bytesEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export interface KeyPair {
  /** X25519 private key (32 bytes). Never leaves the device. */
  priv: Bytes;
  /** X25519 public key (32 bytes). */
  pub: Bytes;
}

export async function generateKeyPair(): Promise<KeyPair> {
  const kp = await crypto.subtle.generateKey({ name: "X25519" } as any, true, ["deriveBits"]);
  const priv = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  // PKCS#8 wraps the 32-byte seed at the tail; keep the raw seed.
  const seed = priv.slice(-32);
  return { priv: seed, pub };
}

async function importPriv(priv: Bytes): Promise<CryptoKey> {
  // Re-wrap the raw 32-byte seed as PKCS#8 (RFC 8410) for import.
  const pkcs8 = concat(
    new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]),
    priv
  );
  return crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, { name: "X25519" } as any, false, ["deriveBits"]);
}

async function importPub(pub: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", pub as BufferSource, { name: "X25519" } as any, false, []);
}

/** X25519 Diffie-Hellman: 32-byte shared secret. */
export async function dh(priv: Bytes, pub: Bytes): Promise<Bytes> {
  const bits = await crypto.subtle.deriveBits(
    { name: "X25519", public: await importPub(pub) } as any,
    await importPriv(priv),
    256
  );
  return new Uint8Array(bits);
}

/** HKDF-SHA256. */
export async function hkdf(salt: Bytes, ikm: Bytes, info: string, len: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: te.encode(info) as BufferSource },
    key, len * 8
  );
  return new Uint8Array(bits);
}

export interface Ciphertext {
  nonce: Bytes; // 12 bytes
  ct: Bytes;
}

/** AES-256-GCM encrypt. `ad` is authenticated but not encrypted (the header). */
export async function seal(key: Bytes, plaintext: Bytes, ad: Bytes): Promise<Ciphertext> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["encrypt"]);
  const nonce = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource, additionalData: ad as BufferSource }, k, plaintext as BufferSource);
  return { nonce, ct: new Uint8Array(ct) };
}

/** AES-256-GCM decrypt. Throws when the key, nonce, ciphertext, or AD is wrong. */
export async function open(key: Bytes, nonce: Bytes, ct: Bytes, ad: Bytes): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce as BufferSource, additionalData: ad as BufferSource }, k, ct as BufferSource);
  return new Uint8Array(pt);
}

export async function sha256(b: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));
}

function cmpBytes(a: Bytes, b: Bytes): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Human-checkable safety number for a pair of identity keys:
 * SHA256(ikA || ikB) rendered as 12 groups of 5 digits. Both sides compute
 * the same number (order-independent: keys sorted first).
 */
export async function safetyNumber(ikA: Bytes, ikB: Bytes): Promise<string> {
  const [x, y] = [ikA, ikB].sort(cmpBytes);
  const h = await sha256(concat(x, y));
  const digits: string[] = [];
  for (let i = 0; i < 12; i++) {
    const v = (h[i * 2] << 8) | h[i * 2 + 1];
    digits.push(String(v % 100000).padStart(5, "0"));
  }
  return digits.join(" ");
}

/** Short fingerprint of one identity key, for display. */
export async function keyFingerprint(pub: Bytes): Promise<string> {
  const h = await sha256(pub);
  return [...h.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
