// outpost-e2ee — X3DH key agreement (X25519-only variant).
// Four DHs like Signal's X3DH, minus the signature (prekey authenticity comes
// from authenticated registration — see README "Threat model"):
//   DH1 = DH(IK_A, SPK_B)   DH2 = DH(EK_A, IK_B)
//   DH3 = DH(EK_A, SPK_B)   DH4 = DH(EK_A, OPK_B)  (when a one-time prekey exists)
// SK = HKDF(DH1 || DH2 || DH3 || [DH4]) → the Double Ratchet root key.

import {
  Bytes, KeyPair, b64uEncode, b64uDecode,
  generateKeyPair, dh, hkdf, concat,
} from "./crypto";

export interface PreKey {
  id: string;
  pub: string; // base64url X25519 public key
}

export interface KeyBundle {
  handle: string;
  ikPub: string;
  spk: PreKey;
  otk?: PreKey; // consumed on fetch — may be absent
}

export interface X3DHInit {
  /** Alice's identity public key (base64url). */
  ikA: string;
  /** Alice's ephemeral public key (base64url). */
  ekPub: string;
  spkId: string;
  otkId?: string;
  rootKey: Bytes;
  /** Alice's ephemeral keypair — becomes her first ratchet keypair. */
  eph: KeyPair;
  /** Bob's signed-prekey public key — Alice's initial peer ratchet key. */
  peerRatchetPub: Bytes;
}

export interface X3DHResult {
  rootKey: Bytes;
  /** Our private key for the responder's receiving ratchet step. */
  ourRatchetPriv: Bytes;
  /** Peer's ephemeral public key — our initial peer ratchet key. */
  peerRatchetPub: Bytes;
}

async function x3dhSecret(dhs: Bytes[]): Promise<Bytes> {
  const zeros = new Uint8Array(32);
  return hkdf(zeros, concat(...dhs), "outpost-e2ee-x3dh-v1", 32);
}

/**
 * Initiator side: agree a root key with the holder of `bundle`.
 * Returns everything Alice needs to build her Double Ratchet session plus
 * the init payload to send Bob in the first envelope.
 */
export async function x3dhInitiate(ikA: KeyPair, bundle: KeyBundle): Promise<X3DHInit> {
  const ikB = b64uDecode(bundle.ikPub);
  const spkB = b64uDecode(bundle.spk.pub);
  const eph = await generateKeyPair();
  const dhs = [
    await dh(ikA.priv, spkB),
    await dh(eph.priv, ikB),
    await dh(eph.priv, spkB),
  ];
  let otkId: string | undefined;
  if (bundle.otk) {
    dhs.push(await dh(eph.priv, b64uDecode(bundle.otk.pub)));
    otkId = bundle.otk.id;
  }
  return {
    ikA: b64uEncode(ikA.pub),
    ekPub: b64uEncode(eph.pub),
    spkId: bundle.spk.id,
    otkId,
    rootKey: await x3dhSecret(dhs),
    eph,
    peerRatchetPub: spkB,
  };
}

export interface ResponderKeys {
  ikPriv: Bytes;
  spkPriv: Bytes;
  otkPriv?: Bytes;
}

/** Responder side: reproduce the root key from Alice's init payload. */
export async function x3dhRespond(init: { ikA: string; ekPub: string; otkId?: string }, keys: ResponderKeys): Promise<X3DHResult> {
  const ikA = b64uDecode(init.ikA);
  const ek = b64uDecode(init.ekPub);
  const dhs = [
    await dh(keys.spkPriv, ikA),
    await dh(keys.ikPriv, ek),
    await dh(keys.spkPriv, ek),
  ];
  if (init.otkId && keys.otkPriv) {
    dhs.push(await dh(keys.otkPriv, ek));
  }
  return {
    rootKey: await x3dhSecret(dhs),
    ourRatchetPriv: keys.spkPriv,
    peerRatchetPub: ek,
  };
}

/** Fresh upload for registration / prekey top-up. */
export async function makePreKeys(n: number): Promise<Array<PreKey & { priv: string }>> {
  const out: Array<PreKey & { priv: string }> = [];
  for (let i = 0; i < n; i++) {
    const kp = await generateKeyPair();
    out.push({ id: "opk_" + b64uEncode(kp.pub).slice(0, 12), pub: b64uEncode(kp.pub), priv: b64uEncode(kp.priv) });
  }
  return out;
}
