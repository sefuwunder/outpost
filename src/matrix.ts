// Minimal Matrix client-server API wrapper for Relay.
// Sending: PUT /rooms/{roomId}/send/m.room.message/{txnId}
// Receiving: GET /sync long-poll, filtered to m.room.message text events.

export class MatrixError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "MatrixError";
  }
}

export interface MatrixConfig {
  homeserver: string; // e.g. https://matrix.org
  token: string;      // user access token
  userId?: string;     // e.g. @you:matrix.org — used to skip our own echoed messages
}

export interface MatrixMessage {
  eventId: string;
  roomId: string;
  sender: string;
  body: string;
  ts: number;
}

function base(cfg: MatrixConfig): string {
  return cfg.homeserver.replace(/\/+$/, "");
}

async function mxFetch(cfg: MatrixConfig, path: string, init?: RequestInit): Promise<any> {
  if (!cfg.homeserver || !cfg.token) throw new MatrixError(400, "Matrix is not configured — add it in Settings");
  let res: Response;
  try {
    res = await fetch(base(cfg) + path, {
      ...init,
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json", ...(init?.headers || {}) },
      signal: (init as any)?.signal,
    });
  } catch (e: any) {
    throw new MatrixError(0, `Matrix homeserver not reachable — ${e.message || "connection failed"}`);
  }
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const msg = body?.error || body?.errcode || `HTTP ${res.status}`;
    throw new MatrixError(res.status, `Matrix: ${msg}`);
  }
  return body;
}

/** Send a plain-text message to a room. Returns the event id. */
export async function matrixSend(cfg: MatrixConfig, roomId: string, text: string): Promise<string> {
  const txnId = `relay-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const r = await mxFetch(cfg, `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`, {
    method: "PUT",
    body: JSON.stringify({ msgtype: "m.text", body: text }),
  });
  if (!r?.event_id) throw new MatrixError(0, "Matrix send returned no event id");
  return r.event_id as string;
}

/** Long-poll /sync. Returns the next batch token plus inbound text messages. */
export async function matrixSync(
  cfg: MatrixConfig,
  since: string | null,
  timeoutMs = 25000
): Promise<{ nextBatch: string; messages: MatrixMessage[] }> {
  const params = new URLSearchParams({ timeout: String(timeoutMs) });
  if (since) params.set("since", since);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs + 10000);
  try {
    const r = await mxFetch(cfg, `/_matrix/client/v3/sync?${params.toString()}`, { signal: ctrl.signal } as any);
    const messages: MatrixMessage[] = [];
    const join = r?.rooms?.join || {};
    for (const roomId of Object.keys(join)) {
      const events = join[roomId]?.timeline?.events || [];
      for (const ev of events) {
        if (ev?.type !== "m.room.message") continue;
        const body = ev?.content?.body;
        if (typeof body !== "string" || !body) continue;
        if (cfg.userId && ev.sender === cfg.userId) continue; // skip our own echo
        messages.push({
          eventId: String(ev.event_id || ""),
          roomId,
          sender: String(ev.sender || ""),
          body,
          ts: Number(ev.origin_server_ts || Date.now()),
        });
      }
    }
    return { nextBatch: String(r.next_batch || since || ""), messages };
  } catch (e: any) {
    if (e?.name === "AbortError") return { nextBatch: since || "", messages: [] };
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Validate the token by fetching our own profile user id. */
export async function validateMatrix(cfg: MatrixConfig): Promise<{ userId: string }> {
  const r = await mxFetch(cfg, "/_matrix/client/v3/account/whoami");
  if (!r?.user_id) throw new MatrixError(0, "Matrix token validation returned no user id");
  return { userId: r.user_id as string };
}

/** List rooms the token's user has joined (id + display name) — for picking a DM room. */
export async function matrixRooms(cfg: MatrixConfig): Promise<{ id: string; name: string }[]> {
  const r = await mxFetch(cfg, "/_matrix/client/v3/joined_rooms");
  const ids: string[] = r?.joined_rooms || [];
  const out: { id: string; name: string }[] = [];
  for (const id of ids.slice(0, 100)) {
    let name = id;
    try {
      const st = await mxFetch(cfg, `/_matrix/client/v3/rooms/${encodeURIComponent(id)}/state/m.room.name/`);
      if (st?.name) name = st.name;
    } catch { /* rooms without a name event */ }
    out.push({ id, name });
  }
  return out;
}
