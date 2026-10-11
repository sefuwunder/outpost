// outpost-e2ee — high-level client. Owns identity keys, sessions, and the
// server conversation (register → bundle → envelopes). Private keys never
// leave this object; the server only ever sees public keys and ciphertext.

import {
  b64uEncode, b64uDecode, generateKeyPair, safetyNumber,
} from "./crypto";
import { RatchetSession, RatchetState, EncryptedMessage } from "./ratchet";
import { x3dhInitiate, x3dhRespond, makePreKeys, KeyBundle, PreKey } from "./x3dh";

const te = new TextEncoder();
const td = new TextDecoder();

export interface KVStore {
  get(k: string): string | null;
  set(k: string, v: string): void;
  del(k: string): void;
}

export function memoryStore(): KVStore {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), del: (k) => m.delete(k) };
}

export function localStorageStore(prefix: string): KVStore {
  return {
    get: (k) => localStorage.getItem(prefix + k),
    set: (k, v) => localStorage.setItem(prefix + k, v),
    del: (k) => localStorage.removeItem(prefix + k),
  };
}

interface StoredPreKey extends PreKey { priv: string }

interface ClientState {
  handle: string;
  ikPriv: string; ikPub: string;
  spkId: string; spkPriv: string; spkPub: string;
  otks: StoredPreKey[];
  sessions: Record<string, { ratchet: RatchetState; peerIkPub: string; needsInit: boolean; initFields?: { ikA: string; ekPub: string; spkId: string; otkId?: string } }>;
}

export interface ReceivedMessage {
  from: string;
  text: string;
  id: string;
  /** Server-side arrival time (ISO), "" when unknown. */
  at: string;
}

const PREKEY_TOPUP = 20;
const PREKEY_LOW_WATER = 5;

export class E2EEClient {
  private constructor(
    private base: string,
    private token: string,
    private store: KVStore,
    private st: ClientState,
  ) {}

  get handle(): string { return this.st.handle; }

  static async create(handle: string, token: string, base: string, store: KVStore): Promise<E2EEClient> {
    const raw = store.get("state");
    if (raw) return new E2EEClient(base, token, store, JSON.parse(raw));
    const ik = await generateKeyPair();
    const spk = await generateKeyPair();
    const otks = await makePreKeys(PREKEY_TOPUP);
    const st: ClientState = {
      handle,
      ikPriv: b64uEncode(ik.priv), ikPub: b64uEncode(ik.pub),
      spkId: "spk_" + b64uEncode(spk.pub).slice(0, 12),
      spkPriv: b64uEncode(spk.priv), spkPub: b64uEncode(spk.pub),
      otks,
      sessions: {},
    };
    const c = new E2EEClient(base, token, store, st);
    c.save();
    return c;
  }

  private save(): void {
    this.store.set("state", JSON.stringify(this.st));
  }

  private async api(path: string, method = "GET", body?: unknown): Promise<any> {
    const url = this.base.replace(/\/$/, "") + path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(this.token);
    const r = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `request failed (${r.status})`);
    return j;
  }

  /** Upload identity + prekeys. Idempotent per handle (re-registers keys). */
  async register(): Promise<void> {
    await this.api("/api/register", "POST", {
      handle: this.st.handle,
      ikPub: this.st.ikPub,
      spk: { id: this.st.spkId, pub: this.st.spkPub },
      otks: this.st.otks.map((o) => ({ id: o.id, pub: o.pub })),
    });
  }

  /** Keep our one-time prekeys topped up. */
  private async topUp(): Promise<void> {
    const me = await this.api("/api/me?handle=" + encodeURIComponent(this.st.handle));
    if ((me.otkCount ?? 0) < PREKEY_LOW_WATER) {
      const fresh = await makePreKeys(PREKEY_TOPUP);
      await this.api("/api/prekeys", "POST", {
        handle: this.st.handle,
        otks: fresh.map((o) => ({ id: o.id, pub: o.pub })),
      });
      this.st.otks.push(...fresh);
      this.save();
    }
  }

  /** Fetch Bob's bundle and run X3DH. Returns the stored session. */
  private async establish(peer: string): Promise<ClientState["sessions"][string]> {
    const bundle = (await this.api("/api/bundle/" + encodeURIComponent(peer))) as KeyBundle;
    const ik = { priv: b64uDecode(this.st.ikPriv), pub: b64uDecode(this.st.ikPub) };
    const init = await x3dhInitiate(ik, bundle);
    const session = await RatchetSession.initInitiator(init.rootKey, init.eph, init.peerRatchetPub);
    const s = {
      ratchet: session.serialize(),
      peerIkPub: bundle.ikPub,
      needsInit: true,
      initFields: { ikA: init.ikA, ekPub: init.ekPub, spkId: init.spkId, otkId: init.otkId },
    };
    this.st.sessions[peer] = s;
    if (init.otkId) this.st.otks = this.st.otks.filter((o) => o.id !== init.otkId);
    this.save();
    return s;
  }

  /** Encrypt and send. Establishes a session on first use. */
  async send(peer: string, text: string): Promise<string> {
    let s = this.st.sessions[peer];
    if (!s) s = await this.establish(peer);
    const session = RatchetSession.deserialize(s.ratchet);
    const msg: EncryptedMessage = await session.encrypt(te.encode(text));
    s.ratchet = session.serialize();
    const envelope: Record<string, unknown> = {
      v: 1, from: this.st.handle, to: peer,
      kind: s.needsInit ? "init" : "msg",
      header: msg.header, nonce: msg.nonce, ct: msg.ct,
    };
    if (s.needsInit && s.initFields) {
      Object.assign(envelope, s.initFields);
      s.needsInit = false;
      delete s.initFields;
    }
    this.save();
    const r = await this.api("/api/envelopes", "POST", { envelope });
    return r.id as string;
  }

  /** Fetch, decrypt, and ack everything waiting for us. */
  async poll(): Promise<ReceivedMessage[]> {
    await this.topUp().catch(() => { /* offline / unregistered — poll anyway */ });
    const { envelopes } = await this.api("/api/envelopes?handle=" + encodeURIComponent(this.st.handle));
    const out: ReceivedMessage[] = [];
    const ack: string[] = [];
    for (const env of envelopes as any[]) {
      try {
        const text = await this.decryptEnvelope(env);
        out.push({ from: env.from, text, id: env.id, at: env.created_at || "" });
      } catch (e: any) {
        out.push({ from: env.from, text: `⚠ could not decrypt: ${e?.message || e}`, id: env.id, at: env.created_at || "" });
      }
      ack.push(env.id);
    }
    if (ack.length) await this.api("/api/envelopes/ack", "POST", { handle: this.st.handle, ids: ack }).catch(() => {});
    return out;
  }

  private async decryptEnvelope(env: any): Promise<string> {
    const peer: string = env.from;
    const s = this.st.sessions[peer];
    if (!s && env.kind === "init") {
      await this.adoptResponderSession(env);
      return this.decryptWithPeer(peer, env);
    }
    if (s && env.kind === "init") {
      // Simultaneous initiation race: both sides X3DH'd at once. Try the
      // existing session first; if it can't read this init, respond to it and
      // let a deterministic tie-break (greater identity key wins) decide
      // which session survives. Converges; fails closed on garbage.
      try {
        return await this.decryptWithPeer(peer, env);
      } catch {
        const old = s;
        await this.adoptResponderSession(env);
        let text: string;
        try {
          text = await this.decryptWithPeer(peer, env);
        } catch {
          this.st.sessions[peer] = old; // garbage init — restore
          this.save();
          throw new Error("init decrypt failed");
        }
        if (this.st.ikPub > env.ikA) {
          this.st.sessions[peer] = old; // we win: keep our initiator session
        }
        this.save();
        return text;
      }
    }
    return this.decryptWithPeer(peer, env);
  }

  /** Build a responder session from an init envelope (does not decrypt). */
  private async adoptResponderSession(env: any): Promise<void> {
    const peer: string = env.from;
    if (env.spkId !== this.st.spkId) throw new Error("unknown signed prekey");
    const otk = env.otkId ? this.st.otks.find((o) => o.id === env.otkId) : undefined;
    if (env.otkId && !otk) throw new Error("one-time prekey already consumed");
    const res = await x3dhRespond(
      { ikA: env.ikA, ekPub: env.ekPub, otkId: env.otkId },
      { ikPriv: b64uDecode(this.st.ikPriv), spkPriv: b64uDecode(this.st.spkPriv), otkPriv: otk ? b64uDecode(otk.priv) : undefined }
    );
    const session = await RatchetSession.initResponder(res.rootKey, res.ourRatchetPriv, res.peerRatchetPub);
    this.st.sessions[peer] = { ratchet: session.serialize(), peerIkPub: env.ikA, needsInit: false };
    if (otk) this.st.otks = this.st.otks.filter((o) => o.id !== otk.id);
    this.save();
  }

  private async decryptWithPeer(peer: string, env: any): Promise<string> {
    const s = this.st.sessions[peer];
    if (!s) throw new Error("no session for " + peer);
    const session = RatchetSession.deserialize(s.ratchet);
    const pt = await session.decrypt({ header: env.header, nonce: env.nonce, ct: env.ct });
    s.ratchet = session.serialize();
    this.save();
    return td.decode(pt);
  }

  /** Safety number to verify out-of-band ("read it to each other"). */
  async safetyNumber(peer: string): Promise<string> {
    const s = this.st.sessions[peer];
    if (!s) throw new Error("no session with " + peer);
    return safetyNumber(b64uDecode(this.st.ikPub), b64uDecode(s.peerIkPub));
  }

  async fingerprint(): Promise<string> {
    const { keyFingerprint } = await import("./crypto");
    return keyFingerprint(b64uDecode(this.st.ikPub));
  }
}
