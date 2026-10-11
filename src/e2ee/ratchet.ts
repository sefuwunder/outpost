// outpost-e2ee — Double Ratchet (Signal-style).
// Root chain ratchets on every new peer DH public key (post-compromise
// security); each sending/receiving chain ratchets per message (forward
// secrecy). Out-of-order messages are handled with skipped message keys.

import {
  Bytes, KeyPair, b64uEncode, b64uDecode,
  generateKeyPair, dh, hkdf, seal, open, concat,
} from "./crypto";

const te = new TextEncoder();

export interface MsgHeader {
  /** Sender's current ratchet public key (base64url). */
  dh: string;
  /** Previous sending-chain length (for skipped-key recovery). */
  pn: number;
  /** Index in the current sending chain. */
  n: number;
}

export interface EncryptedMessage {
  header: MsgHeader;
  nonce: string;
  ct: string;
}

export function encodeHeader(h: MsgHeader): Bytes {
  return te.encode(JSON.stringify({ dh: h.dh, pn: h.pn, n: h.n }));
}

/** (rootKey, chainKey) = KDF_RK(rootKey, dhOut) */
async function kdfRk(rk: Bytes, dhOut: Bytes): Promise<[Bytes, Bytes]> {
  const out = await hkdf(rk, dhOut, "outpost-e2ee-rk-v1", 64);
  return [out.slice(0, 32), out.slice(32, 64)];
}

/** (chainKey, messageKey) = KDF_CK(chainKey) */
async function kdfCk(ck: Bytes): Promise<[Bytes, Bytes]> {
  const nextCk = await hkdf(ck, new Uint8Array([0x01]), "outpost-e2ee-ck-v1", 32);
  const mk = await hkdf(ck, new Uint8Array([0x02]), "outpost-e2ee-mk-v1", 32);
  return [nextCk, mk];
}

const MAX_SKIP = 2000;

export interface RatchetState {
  rk: string;
  ckS?: string;
  ckR?: string;
  dhSPriv: string; dhSPub: string;
  dhR?: string;
  ns: number; nr: number; pn: number;
  skipped: Array<[string, string]>; // [keyId, messageKey] in arrival order
}

function skipId(dh: string, n: number): string {
  return dh + ":" + n;
}

export class RatchetSession {
  private st: RatchetState;

  private constructor(st: RatchetState) { this.st = st; }

  /** Initiator (Alice) after X3DH: root key + ephemeral as first ratchet key. */
  static async initInitiator(rootKey: Bytes, eph: KeyPair, peerRatchetPub: Bytes): Promise<RatchetSession> {
    const [rk, ckS] = await kdfRk(rootKey, await dh(eph.priv, peerRatchetPub));
    return new RatchetSession({
      rk: b64uEncode(rk), ckS: b64uEncode(ckS),
      dhSPriv: b64uEncode(eph.priv), dhSPub: b64uEncode(eph.pub),
      dhR: b64uEncode(peerRatchetPub),
      ns: 0, nr: 0, pn: 0, skipped: [],
    });
  }

  /** Responder (Bob) after X3DH: derive receiving chain, stage a sending key. */
  static async initResponder(rootKey: Bytes, ourRatchetPriv: Bytes, peerRatchetPub: Bytes): Promise<RatchetSession> {
    const [rk1, ckR] = await kdfRk(rootKey, await dh(ourRatchetPriv, peerRatchetPub));
    const fresh = await generateKeyPair();
    const [rk2, ckS] = await kdfRk(rk1, await dh(fresh.priv, peerRatchetPub));
    return new RatchetSession({
      rk: b64uEncode(rk2), ckS: b64uEncode(ckS), ckR: b64uEncode(ckR),
      dhSPriv: b64uEncode(fresh.priv), dhSPub: b64uEncode(fresh.pub),
      dhR: b64uEncode(peerRatchetPub),
      ns: 0, nr: 0, pn: 0, skipped: [],
    });
  }

  /** Encrypt one message. Returns the wire envelope (header in clear, body sealed). */
  async encrypt(plaintext: Bytes, ad: Bytes = new Uint8Array(0)): Promise<EncryptedMessage> {
    if (!this.st.ckS) throw new Error("ratchet: no sending chain");
    const [ckS, mk] = await kdfCk(b64uDecode(this.st.ckS));
    this.st.ckS = b64uEncode(ckS);
    const header: MsgHeader = { dh: this.st.dhSPub, pn: this.st.pn, n: this.st.ns };
    const headerBytes = concat(encodeHeader(header), ad);
    const { nonce, ct } = await seal(mk, plaintext, headerBytes);
    this.st.ns++;
    return { header, nonce: b64uEncode(nonce), ct: b64uEncode(ct) };
  }

  /** Decrypt one message. Handles out-of-order delivery and DH ratchet steps. */
  async decrypt(msg: EncryptedMessage, ad: Bytes = new Uint8Array(0)): Promise<Bytes> {
    const headerBytes = concat(encodeHeader(msg.header), ad);
    const id = skipId(msg.header.dh, msg.header.n);
    const skipIdx = this.st.skipped.findIndex(([k]) => k === id);
    if (skipIdx >= 0) {
      const [, mkB64] = this.st.skipped.splice(skipIdx, 1)[0];
      return open(b64uDecode(mkB64), b64uDecode(msg.nonce), b64uDecode(msg.ct), headerBytes);
    }
    if (msg.header.dh !== this.st.dhR) {
      await this.dhRatchet(msg.header);
    }
    // Fast-forward the receiving chain, stashing keys for late messages.
    while (this.st.nr < msg.header.n) {
      await this.storeSkipped(this.st.dhR!, this.st.nr);
      this.st.nr++;
    }
    if (!this.st.ckR) throw new Error("ratchet: no receiving chain");
    const [ckR, mk] = await kdfCk(b64uDecode(this.st.ckR));
    this.st.ckR = b64uEncode(ckR);
    this.st.nr++;
    return open(mk, b64uDecode(msg.nonce), b64uDecode(msg.ct), headerBytes);
  }

  /** Peer introduced a new ratchet key: finish the old chain, start new ones. */
  private async dhRatchet(header: MsgHeader): Promise<void> {
    // Stash keys for messages sent on the old chain that may arrive late.
    while (this.st.nr < header.pn) {
      await this.storeSkipped(this.st.dhR!, this.st.nr);
      this.st.nr++;
    }
    this.st.pn = 0;
    this.st.nr = 0;
    const rk = b64uDecode(this.st.rk);
    const [rk1, ckR] = await kdfRk(rk, await dh(b64uDecode(this.st.dhSPriv), b64uDecode(header.dh)));
    this.st.rk = b64uEncode(rk1);
    this.st.ckR = b64uEncode(ckR);
    this.st.dhR = header.dh;
    // New sending chain off the fresh root.
    const fresh = await generateKeyPair();
    const [rk2, ckS] = await kdfRk(b64uDecode(this.st.rk), await dh(fresh.priv, b64uDecode(header.dh)));
    this.st.rk = b64uEncode(rk2);
    this.st.ckS = b64uEncode(ckS);
    this.st.dhSPriv = b64uEncode(fresh.priv);
    this.st.dhSPub = b64uEncode(fresh.pub);
    this.st.ns = 0;
  }

  private async storeSkipped(dh: string, n: number): Promise<void> {
    if (!this.st.ckR) throw new Error("ratchet: no receiving chain");
    const [ckR, mk] = await kdfCk(b64uDecode(this.st.ckR));
    this.st.ckR = b64uEncode(ckR);
    this.st.skipped.push([skipId(dh, n), b64uEncode(mk)]);
    while (this.st.skipped.length > MAX_SKIP) this.st.skipped.shift();
  }

  /** Serialize for persistence (private keys stay on this device only). */
  serialize(): RatchetState {
    return JSON.parse(JSON.stringify(this.st));
  }

  static deserialize(st: RatchetState): RatchetSession {
    return new RatchetSession(JSON.parse(JSON.stringify(st)));
  }

  /** For tests: how many skipped keys are being held. */
  skippedCount(): number {
    return this.st.skipped.length;
  }
}
