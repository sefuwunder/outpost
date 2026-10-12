// GNOME Online Accounts as an optional email provider for outpost.
//
// Talks to goa-daemon on the session bus via `busctl --json` (systemd —
// present on any GNOME install), so no D-Bus client library is needed.
// The subprocess runner is injectable, so tests never touch D-Bus.
//
// What we use from GOA:
//   GetManagedObjects on org.gnome.OnlineAccounts → account objects
//   org.gnome.OnlineAccounts.Account: Id, ProviderType, ProviderName,
//     MailEnabled, PresentationIdentity
//   org.gnome.OnlineAccounts.Mail: EmailAddress, ImapHost/UserName,
//     ImapUseSsl/Tls, SmtpHost/UserName, SmtpUseSsl/Tls/Auth, SmtpAuthXoauth2
//   org.gnome.OnlineAccounts.OAuth2Based.GetAccessToken() → fresh token
//     (goa-daemon refreshes it from the keyring-stored refresh token)
//   org.gnome.OnlineAccounts.Account.EnsureCredentials() first, per the GOA
//     docs — this is what refreshes expired credentials
//   org.gnome.OnlineAccounts.PasswordBased.GetPassword("imap-password" |
//     "smtp-password") — these are the ids GOA's own backends store under
//
// Tokens/passwords are fetched on demand and never written to outpost's DB.

import { existsSync } from "node:fs";

export class GoaError extends Error {
  kind: "unavailable" | "call-failed" | "no-account" | "auth";
  constructor(kind: GoaError["kind"], msg: string) {
    super(msg);
    this.kind = kind;
  }
}

export interface GoaMailAccount {
  /** D-Bus object path, e.g. /org/gnome/OnlineAccounts/Accounts/1234 */
  objectPath: string;
  /** GOA account Id, e.g. goa_account_1687... — stable key for settings. */
  id: string;
  providerType: string;
  providerName: string;
  email: string;
  imapHost: string;
  imapUser: string;
  imapSsl: boolean;
  imapTls: boolean;
  smtpHost: string;
  smtpUser: string;
  smtpSsl: boolean;
  smtpTls: boolean;
  smtpAuth: boolean;
  smtpXoauth2: boolean;
  oauth2: boolean;
  passwordBased: boolean;
}

export interface GoaCredentials {
  /** Login identity (email). */
  user: string;
  oauth2: boolean;
  /** OAuth2 access token (oauth2 only). */
  token?: string;
  /** Plain passwords (passwordBased only). */
  imapPassword?: string;
  smtpPassword?: string;
}

export type RunFn = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const BUSCTL_TIMEOUT_MS = 20000;

/** Extra env for busctl: when this process was launched outside the GNOME
 *  session (no DBUS_SESSION_BUS_ADDRESS), fall back to the standard user
 *  bus socket so GOA still works. */
export function busEnv(): Record<string, string> {
  if (process.env.DBUS_SESSION_BUS_ADDRESS) return {};
  const uid = process.getuid?.();
  const sock = uid !== undefined ? `/run/user/${uid}/bus` : "";
  try {
    if (sock && existsSync(sock)) {
      return { DBUS_SESSION_BUS_ADDRESS: `unix:path=${sock}` };
    }
  } catch { /* ignore */ }
  return {};
}

async function defaultRun(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([cmd, ...args], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ...busEnv() },
  });
  const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } }, BUSCTL_TIMEOUT_MS);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).catch((e: any) => {
    clearTimeout(timer);
    throw new GoaError("unavailable", `could not run ${cmd}: ${e?.message || e}`);
  });
  clearTimeout(timer);
  return { code, stdout, stderr };
}

// ---------- busctl --json parsing ----------
// busctl --json=short call ... prints {"type": sig, "data": ...} with nested
// values wrapped as {"type", "data"} objects. The parser below is structural:
// it unwraps those wrappers and folds arrays-of-pairs into dicts, so it also
// tolerates partially-unwrapped shapes.

type BusVal = { type: string; data: any };

function isBusVal(v: any): v is BusVal {
  return !!v && typeof v === "object" && !Array.isArray(v) &&
    typeof v.type === "string" && "data" in v && Object.keys(v).length === 2;
}

function busData(v: any): any {
  if (isBusVal(v)) return busData(v.data);
  if (Array.isArray(v)) {
    // dict shape: every element is a [key, value] pair with a scalar key
    if (v.length > 0 && v.every((e) => Array.isArray(e) && e.length === 2 &&
        (typeof e[0] === "string" || typeof e[0] === "number"))) {
      const o: Record<string, any> = {};
      for (const [k, vv] of v) o[String(k)] = busData(vv);
      return o;
    }
    return v.map(busData);
  }
  if (v && typeof v === "object") {
    const o: Record<string, any> = {};
    for (const [k, vv] of Object.entries(v)) o[k] = busData(vv);
    return o;
  }
  return v;
}

const GOA_BUS = "org.gnome.OnlineAccounts";
const GOA_ROOT = "/org/gnome/OnlineAccounts";

async function busCall(run: RunFn, dest: string, path: string, iface: string, method: string, ...args: string[]): Promise<any[]> {
  let res: { code: number; stdout: string; stderr: string };
  try {
    res = await run("busctl", ["--user", "--json=short", "call", dest, path, iface, method, ...args]);
  } catch (e: any) {
    if (e instanceof GoaError) throw e;
    throw new GoaError("unavailable", `could not run busctl: ${e?.message || e}`);
  }
  if (res.code !== 0) {
    const err = (res.stderr || res.stdout || "").trim().slice(0, 300);
    if (/ServiceUnknown|Failed to connect|Failed to set bus address|not provided by any|No such/i.test(err)) {
      throw new GoaError("unavailable", `GNOME Online Accounts not reachable: ${err || "busctl failed"}`);
    }
    throw new GoaError("call-failed", `D-Bus call ${iface}.${method} failed: ${err || "exit " + res.code}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new GoaError("call-failed", `could not parse busctl output for ${iface}.${method}`);
  }
  // busctl reports the full reply signature, e.g.
  // {"type":"(a{oa{sa{sv}}})","data":[...]} — data is the out-args array.
  if (!isBusVal(parsed)) {
    throw new GoaError("call-failed", `unexpected busctl output shape for ${iface}.${method}`);
  }
  const data = parsed.data;
  const outArgs = Array.isArray(data) ? data : [data];
  return outArgs.map(busData);
}

const str = (v: any) => (typeof v === "string" ? v : v == null ? "" : String(v));
const bool = (v: any) => v === true;

function toAccount(objectPath: string, ifaces: Record<string, Record<string, any>>): GoaMailAccount | null {
  const acc = ifaces["org.gnome.OnlineAccounts.Account"];
  const mail = ifaces["org.gnome.OnlineAccounts.Mail"];
  if (!acc || !mail) return null;
  if (!bool(acc["MailEnabled"])) return null;
  const email = str(mail["EmailAddress"]) || str(mail["ImapUserName"]) || str(acc["PresentationIdentity"]);
  if (!email) return null;
  return {
    objectPath,
    id: str(acc["Id"]),
    providerType: str(acc["ProviderType"]),
    providerName: str(acc["ProviderName"]) || str(acc["ProviderType"]),
    email,
    imapHost: str(mail["ImapHost"]),
    imapUser: str(mail["ImapUserName"]) || email,
    imapSsl: bool(mail["ImapUseSsl"]),
    imapTls: bool(mail["ImapUseTls"]),
    smtpHost: str(mail["SmtpHost"]),
    smtpUser: str(mail["SmtpUserName"]) || email,
    smtpSsl: bool(mail["SmtpUseSsl"]),
    smtpTls: bool(mail["SmtpUseTls"]),
    smtpAuth: bool(mail["SmtpUseAuth"]),
    smtpXoauth2: bool(mail["SmtpAuthXoauth2"]),
    oauth2: "org.gnome.OnlineAccounts.OAuth2Based" in ifaces,
    passwordBased: "org.gnome.OnlineAccounts.PasswordBased" in ifaces,
  };
}

/** True when goa-daemon is reachable on the session bus. Never throws. */
export async function goaAvailable(run: RunFn = defaultRun): Promise<boolean> {
  try {
    await busCall(run, GOA_BUS, GOA_ROOT, "org.freedesktop.DBus.ObjectManager", "GetManagedObjects");
    return true;
  } catch (e) {
    if (e instanceof GoaError && e.kind === "unavailable") return false;
    return false;
  }
}

/** Raw managed objects from goa-daemon (unfiltered). */
export async function rawGoaObjects(run: RunFn = defaultRun): Promise<Record<string, Record<string, Record<string, any>>>> {
  const [objs] = await busCall(run, GOA_BUS, GOA_ROOT, "org.freedesktop.DBus.ObjectManager", "GetManagedObjects");
  return (objs || {}) as Record<string, Record<string, Record<string, any>>>;
}

/** Mail-capable GOA accounts. Throws GoaError("unavailable") when GOA isn't reachable. */
export async function listGoaMailAccounts(run: RunFn = defaultRun): Promise<GoaMailAccount[]> {
  const objs = await rawGoaObjects(run);
  const out: GoaMailAccount[] = [];
  for (const [path, ifaces] of Object.entries(objs || {})) {
    try {
      const a = toAccount(path, ifaces);
      if (a) out.push(a);
    } catch { /* skip malformed account entries */ }
  }
  return out;
}

/** Redacted structural summary of what goa-daemon reports — for debugging
 *  "no accounts" without leaking emails or tokens. */
export async function goaDebug(run: RunFn = defaultRun): Promise<Record<string, any>> {
  const info: Record<string, any> = {
    uid: process.getuid?.(),
    dbusSessionBusAddressSet: !!process.env.DBUS_SESSION_BUS_ADDRESS,
    busEnvFallback: busEnv(),
    busctl: null as string | null,
    callOk: false,
    error: null as string | null,
    objectCount: 0,
    objects: [] as any[],
  };
  try {
    const v = await run("busctl", ["--version"]);
    info.busctl = (v.stdout || "").split("\n")[0].slice(0, 40);
  } catch (e: any) {
    info.busctl = `missing: ${e?.message || e}`.slice(0, 80);
  }
  try {
    const rawRes = await run("busctl", ["--user", "--json=short", "call",
      "org.gnome.OnlineAccounts", "/org/gnome/OnlineAccounts",
      "org.freedesktop.DBus.ObjectManager", "GetManagedObjects"]);
    let sample = (rawRes.stdout || "").slice(0, 1500);
    sample = sample.replace(/"data":"[^"]*@[^"]*"/g, '"data":"<email>"');
    info.rawSample = sample;
  } catch (e: any) {
    info.rawSample = `unavailable: ${String(e?.message || e).slice(0, 120)}`;
  }
  try {
    const objs = await rawGoaObjects(run);
    info.callOk = true;
    const paths = Object.keys(objs || {});
    info.objectCount = paths.length;
    for (const p of paths) {
      const ifaces = objs[p] || {};
      const acc = ifaces["org.gnome.OnlineAccounts.Account"] || {};
      info.objects.push({
        path: p,
        interfaces: Object.keys(ifaces),
        Id: String(acc["Id"] || "").slice(0, 40),
        ProviderType: String(acc["ProviderType"] || "").slice(0, 30),
        MailEnabled: acc["MailEnabled"] === true,
        MailEnabledRaw: typeof acc["MailEnabled"],
        hasMailIface: "org.gnome.OnlineAccounts.Mail" in ifaces,
        emailPresent: !!(ifaces["org.gnome.OnlineAccounts.Mail"]?.["EmailAddress"] ||
          ifaces["org.gnome.OnlineAccounts.Mail"]?.["ImapUserName"] || acc["PresentationIdentity"]),
      });
    }
  } catch (e: any) {
    info.error = `${e instanceof GoaError ? `[${e.kind}] ` : ""}${String(e?.message || e)}`.slice(0, 300);
  }
  return info;
}

/** Fetch fresh credentials for one account. Tokens come from the keyring via goa-daemon. */
export async function getGoaCredentials(acct: GoaMailAccount, run: RunFn = defaultRun): Promise<GoaCredentials> {
  // Per the GOA docs (and Geary's GoaMediator): ensure credentials first —
  // this refreshes expired tokens/passwords from the keyring before we ask
  // for them. A failure here means the account needs re-auth in Settings.
  try {
    await busCall(run, GOA_BUS, acct.objectPath, "org.gnome.OnlineAccounts.Account", "EnsureCredentials");
  } catch (e: any) {
    throw new GoaError("auth", `GOA account ${acct.email}: credentials need refresh — re-authenticate in GNOME Settings (${String(e?.message || e).slice(0, 120)})`);
  }
  if (acct.oauth2) {
    const [token] = await busCall(run, GOA_BUS, acct.objectPath, "org.gnome.OnlineAccounts.OAuth2Based", "GetAccessToken");
    if (typeof token !== "string" || !token) throw new GoaError("auth", `GOA account ${acct.email}: no access token`);
    return { user: acct.email, oauth2: true, token };
  }
  if (acct.passwordBased) {
    const [imapPassword] = await busCall(run, GOA_BUS, acct.objectPath, "org.gnome.OnlineAccounts.PasswordBased", "GetPassword", "s", "imap-password");
    const [smtpPassword] = await busCall(run, GOA_BUS, acct.objectPath, "org.gnome.OnlineAccounts.PasswordBased", "GetPassword", "s", "smtp-password");
    if (!imapPassword) throw new GoaError("auth", `GOA account ${acct.email}: no stored IMAP password`);
    return { user: acct.email, oauth2: false, imapPassword: String(imapPassword), smtpPassword: String(smtpPassword || "") };
  }
  throw new GoaError("auth", `GOA account ${acct.email}: neither OAuth2 nor password credentials available`);
}

// ---------- pure config mappers (no I/O; unit-tested) ----------

export interface GoaImapCfg { host: string; port: number; user: string; secure: boolean }
export interface GoaSmtpCfg { host: string; port: number; user: string; secure: "ssl" | "starttls" }

/** IMAP connection for a GOA account. Ports follow the account's TLS flags (993/143). */
export function goaImapCfg(acct: GoaMailAccount): GoaImapCfg {
  if (!acct.imapHost) throw new GoaError("no-account", `GOA account ${acct.email} has no IMAP host`);
  if (!acct.imapSsl) throw new GoaError("no-account", `GOA account ${acct.email} needs IMAP STARTTLS, which outpost doesn't support yet`);
  return { host: acct.imapHost, port: 993, user: acct.imapUser, secure: true };
}

/** SMTP connection for a GOA account. Ports follow the account's TLS flags (465/587). */
export function goaSmtpCfg(acct: GoaMailAccount): GoaSmtpCfg {
  if (!acct.smtpHost) throw new GoaError("no-account", `GOA account ${acct.email} has no SMTP host`);
  if (acct.smtpSsl) return { host: acct.smtpHost, port: 465, user: acct.smtpUser, secure: "ssl" };
  if (acct.smtpTls) return { host: acct.smtpHost, port: 587, user: acct.smtpUser, secure: "starttls" };
  throw new GoaError("no-account", `GOA account ${acct.email} needs unencrypted SMTP, which outpost won't do`);
}
