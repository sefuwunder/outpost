// GOA provider tests — busctl parsing, credential flows, XOAUTH2, config mapping.
// The D-Bus layer is faked via an injected runner; no GNOME session needed.
import { test, expect, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OUTPOST_DATA = join(tmpdir(), `outpost-test-${process.pid}-${Math.random().toString(36).slice(2)}`);

const db = await import("../src/db.ts");
const goa = await import("../src/goa.ts");
const ch = await import("../src/channels.ts");
const imap = await import("../src/imap.ts");

beforeEach(() => {
  db.openDb(join(process.env.OUTPOST_DATA!, "t.db"));
  db.getDb().exec("DELETE FROM settings;");
});

// ---------- fake busctl ----------
// Realistic GetManagedObjects payload: one OAuth2 google account, one
// password-based account, one with Mail disabled, one without a Mail iface.
const GOOGLE_PATH = "/org/gnome/OnlineAccounts/Accounts/1001";
const PW_PATH = "/org/gnome/OnlineAccounts/Accounts/1002";

function managedObjectsJson() {
  const v = (type: string, data: any) => ({ type, data });
  const props = (entries: Array<[string, any]>) => v("a{sv}", entries.map(([k, vv]) => [k, vv]));
  const acct = (id: string, ptype: string, pname: string, mailEnabled: boolean, ident: string) =>
    ["org.gnome.OnlineAccounts.Account", props([
      ["Id", v("s", id)],
      ["ProviderType", v("s", ptype)],
      ["ProviderName", v("s", pname)],
      ["MailEnabled", v("b", mailEnabled)],
      ["PresentationIdentity", v("s", ident)],
    ])];
  const mail = (email: string, ihost: string, shost: string, imapTls = false) =>
    ["org.gnome.OnlineAccounts.Mail", props([
      ["EmailAddress", v("s", email)],
      ["ImapHost", v("s", ihost)],
      ["ImapUserName", v("s", email)],
      ["ImapUseSsl", v("b", !imapTls)],
      ["ImapUseTls", v("b", imapTls)],
      ["SmtpHost", v("s", shost)],
      ["SmtpUserName", v("s", email)],
      ["SmtpUseSsl", v("b", false)],
      ["SmtpUseTls", v("b", true)],
      ["SmtpUseAuth", v("b", true)],
      ["SmtpAuthXoauth2", v("b", true)],
    ])];
  // Newer GOA exposes MailDisabled (inverted) instead of MailEnabled.
  const acctNewGoa = (id: string, ptype: string, pname: string, mailDisabled: boolean, ident: string) =>
    ["org.gnome.OnlineAccounts.Account", props([
      ["Id", v("s", id)],
      ["ProviderType", v("s", ptype)],
      ["ProviderName", v("s", pname)],
      ["MailDisabled", v("b", mailDisabled)],
      ["PresentationIdentity", v("s", ident)],
    ])];
  const ifaces = (list: any[]) => v("a{sa{sv}}", list);
  const objs: any[] = [
    [GOOGLE_PATH, ifaces([acct("goa_account_1001", "google", "Google", true, "ada@gmail.com"),
      mail("ada@gmail.com", "imap.gmail.com", "smtp.gmail.com"),
      ["org.gnome.OnlineAccounts.OAuth2Based", props([])]])],
    [PW_PATH, ifaces([acct("goa_account_1002", "imap_smtp", "Mail", true, "bob@example.com"),
      mail("bob@example.com", "imap.example.com", "smtp.example.com"),
      ["org.gnome.OnlineAccounts.PasswordBased", props([])]])],
    ["/org/gnome/OnlineAccounts/Accounts/1003",
      ifaces([acct("goa_account_1003", "google", "Google", false, "carol@gmail.com"),
        mail("carol@gmail.com", "imap.gmail.com", "smtp.gmail.com"),
        ["org.gnome.OnlineAccounts.OAuth2Based", props([])]])],
    ["/org/gnome/OnlineAccounts/Accounts/1004",
      ifaces([acct("goa_account_1004", "owncloud", "Nextcloud", true, "dave"),
        ["org.gnome.OnlineAccounts.Documents", props([])]])], // no Mail iface
    // Newer GOA shape: MailDisabled instead of MailEnabled.
    ["/org/gnome/OnlineAccounts/Accounts/1005",
      ifaces([acctNewGoa("goa_account_1005", "google", "Google", false, "erin@gmail.com"),
        mail("erin@gmail.com", "imap.gmail.com", "smtp.gmail.com"),
        ["org.gnome.OnlineAccounts.OAuth2Based", props([])]])],
    ["/org/gnome/OnlineAccounts/Accounts/1006",
      ifaces([acctNewGoa("goa_account_1006", "google", "Google", true, "frank@gmail.com"),
        mail("frank@gmail.com", "imap.gmail.com", "smtp.gmail.com"),
        ["org.gnome.OnlineAccounts.OAuth2Based", props([])]])], // MailDisabled → excluded
  ];
  // busctl reports the full reply signature: {"type":"(a{oa{sa{sv}}})","data":[...]}
  return JSON.stringify({ type: "(a{oa{sa{sv}}})", data: [objs] });
}

function fakeRun(calls: string[]) {
  const run: goa.RunFn = async (_cmd, args) => {
    calls.push(args.join(" "));
    const m = args.indexOf("call");
    const method = args[m + 4];
    if (method === "GetManagedObjects") return { code: 0, stdout: managedObjectsJson(), stderr: "" };
    if (method === "EnsureCredentials") return { code: 0, stdout: JSON.stringify({ type: "()", data: [] }), stderr: "" };
    if (method === "GetAccessToken") return { code: 0, stdout: JSON.stringify({ type: "(s)", data: ["ya29.faketoken"] }), stderr: "" };
    if (method === "GetPassword") {
      const id = args[args.length - 1];
      return { code: 0, stdout: JSON.stringify({ type: "(s)", data: [`pw-for-${id}`] }), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unknown method" };
  };
  return run;
}

test("listGoaMailAccounts parses busctl JSON and filters to mail-enabled accounts", async () => {
  const calls: string[] = [];
  const accts = await goa.listGoaMailAccounts(fakeRun(calls));
  expect(accts.length).toBe(3);
  const g = accts.find((a) => a.id === "goa_account_1001")!;
  expect(g.email).toBe("ada@gmail.com");
  expect(g.providerName).toBe("Google");
  expect(g.imapHost).toBe("imap.gmail.com");
  expect(g.smtpHost).toBe("smtp.gmail.com");
  expect(g.imapSsl).toBe(true);
  expect(g.smtpTls).toBe(true);
  expect(g.oauth2).toBe(true);
  expect(g.passwordBased).toBe(false);
  const p = accts.find((a) => a.id === "goa_account_1002")!;
  expect(p.oauth2).toBe(false);
  expect(p.passwordBased).toBe(true);
  // mail-disabled and no-Mail-iface accounts are excluded
  expect(accts.some((a) => a.id === "goa_account_1003")).toBe(false);
  expect(accts.some((a) => a.id === "goa_account_1004")).toBe(false);
  // newer GOA shape: MailDisabled=false is mail-enabled, =true is excluded
  expect(accts.some((a) => a.id === "goa_account_1005")).toBe(true);
  expect(accts.find((a) => a.id === "goa_account_1005")!.email).toBe("erin@gmail.com");
  expect(accts.some((a) => a.id === "goa_account_1006")).toBe(false);
});

test("goaAvailable is false when busctl is missing", async () => {
  const run: goa.RunFn = async () => { throw new Error("spawn busctl ENOENT"); };
  expect(await goa.goaAvailable(run)).toBe(false);
});

test("goaAvailable is false when goa-daemon is not on the bus", async () => {
  const run: goa.RunFn = async () => ({ code: 1, stdout: "", stderr: "Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name org.gnome.OnlineAccounts was not provided by any .service files" });
  expect(await goa.goaAvailable(run)).toBe(false);
});

test("goaAvailable is false with no session bus at all", async () => {
  const run: goa.RunFn = async () => ({ code: 1, stdout: "", stderr: "Failed to set bus address: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined" });
  expect(await goa.goaAvailable(run)).toBe(false);
});

test("OAuth2 credentials come from GetAccessToken", async () => {
  const calls: string[] = [];
  const accts = await goa.listGoaMailAccounts(fakeRun(calls));
  const creds = await goa.getGoaCredentials(accts[0], fakeRun(calls));
  expect(creds.oauth2).toBe(true);
  expect(creds.token).toBe("ya29.faketoken");
  expect(creds.user).toBe("ada@gmail.com");
  expect(calls.some((c) => c.includes("OAuth2Based GetAccessToken"))).toBe(true);
  expect(calls.some((c) => c.includes(GOOGLE_PATH))).toBe(true);
  // EnsureCredentials runs first, per the GOA docs (Geary does the same)
  const ensureIdx = calls.findIndex((c) => c.includes("Account EnsureCredentials"));
  const tokenIdx = calls.findIndex((c) => c.includes("OAuth2Based GetAccessToken"));
  expect(ensureIdx).toBeGreaterThanOrEqual(0);
  expect(ensureIdx).toBeLessThan(tokenIdx);
});

test("EnsureCredentials failure becomes a re-authenticate error", async () => {
  const calls: string[] = [];
  const base = fakeRun(calls);
  const run: goa.RunFn = async (cmd, args) => {
    if (args.includes("EnsureCredentials")) return { code: 1, stdout: "", stderr: "GDBus.Error:org.gnome.OnlineAccounts.Error.NotAuthorized" };
    return base(cmd, args);
  };
  const accts = await goa.listGoaMailAccounts(base);
  await expect(goa.getGoaCredentials(accts[0], run)).rejects.toThrow(/re-authenticate in GNOME Settings/);
});

test("password credentials come from GetPassword imap-password/smtp-password", async () => {
  const calls: string[] = [];
  const accts = await goa.listGoaMailAccounts(fakeRun(calls));
  const creds = await goa.getGoaCredentials(accts[1], fakeRun(calls));
  expect(creds.oauth2).toBe(false);
  expect(creds.imapPassword).toBe("pw-for-imap-password");
  expect(creds.smtpPassword).toBe("pw-for-smtp-password");
  // GOA's own backends store under these ids (Geary uses them too)
  expect(calls.some((c) => c.includes("GetPassword s imap-password"))).toBe(true);
  expect(calls.some((c) => c.includes("GetPassword s smtp-password"))).toBe(true);
});

test("goaImapCfg/goaSmtpCfg map TLS flags to standard ports", async () => {
  const calls: string[] = [];
  const accts = await goa.listGoaMailAccounts(fakeRun(calls));
  const ic = goa.goaImapCfg(accts[0]);
  expect(ic).toEqual({ host: "imap.gmail.com", port: 993, user: "ada@gmail.com", secure: true });
  const sc = goa.goaSmtpCfg(accts[0]);
  expect(sc).toEqual({ host: "smtp.gmail.com", port: 587, user: "ada@gmail.com", secure: "starttls" });
});

test("goaImapCfg rejects non-SSL IMAP and missing hosts", async () => {
  const calls: string[] = [];
  const accts = await goa.listGoaMailAccounts(fakeRun(calls));
  const tlsOnly = { ...accts[0], imapSsl: false, imapTls: true };
  expect(() => goa.goaImapCfg(tlsOnly)).toThrow(/STARTTLS/);
  const noHost = { ...accts[0], imapHost: "" };
  expect(() => goa.goaImapCfg(noHost)).toThrow(/no IMAP host/);
  const noSmtp = { ...accts[0], smtpSsl: false, smtpTls: false };
  expect(() => goa.goaSmtpCfg(noSmtp)).toThrow(/unencrypted/);
});

test("goaDebug summarizes objects without leaking emails", async () => {
  const calls: string[] = [];
  const d = await goa.goaDebug(fakeRun(calls));
  expect(d.callOk).toBe(true);
  expect(d.objectCount).toBe(6);
  const g = d.objects.find((o: any) => o.Id === "goa_account_1001");
  expect(g.ProviderType).toBe("google");
  expect(g.MailEnabled).toBe(true);
  expect(g.hasMailIface).toBe(true);
  expect(g.emailPresent).toBe(true);
  expect(JSON.stringify(d)).not.toContain("ada@gmail.com");
  const nomail = d.objects.find((o: any) => o.Id === "goa_account_1004");
  expect(nomail.hasMailIface).toBe(false);
});

test("xoauth2Blob builds the RFC 7628 initial response", () => {
  const blob = imap.xoauth2Blob("ada@gmail.com", "tok123");
  const raw = Buffer.from(blob, "base64").toString("utf8");
  expect(raw).toBe("user=ada@gmail.com\x01auth=Bearer tok123\x01\x01");
});

test("emailImapConfig/emailSmtpConfig resolve the GOA provider", async () => {
  const calls: string[] = [];
  const run = fakeRun(calls);
  db.setSetting("email_provider", "goa");
  db.setSetting("goa_account", "goa_account_1001");
  expect(ch.emailProvider()).toBe("goa");
  expect(ch.emailReady()).toBe(true);
  const ic = await ch.emailImapConfig(run);
  expect(ic.host).toBe("imap.gmail.com");
  expect(ic.port).toBe(993);
  expect(ic.user).toBe("ada@gmail.com");
  expect(ic.xoauth2Token).toBe("ya29.faketoken");
  const sc = await ch.emailSmtpConfig(run);
  expect(sc.host).toBe("smtp.gmail.com");
  expect(sc.port).toBe(587);
  expect(sc.secure).toBe("starttls");
  expect(sc.from).toBe("ada@gmail.com");
  expect(sc.xoauth2Token).toBe("ya29.faketoken");
});

test("emailImapConfig falls back to manual settings by default", async () => {
  db.setSetting("imap_host", "imap.x.com");
  db.setSetting("imap_port", "993");
  db.setSetting("imap_user", "me@x.com");
  db.setSetting("imap_pass", "secret");
  const ic = await ch.emailImapConfig();
  expect(ic.host).toBe("imap.x.com");
  expect(ic.xoauth2Token).toBeUndefined();
});

test("GOA provider with no account chosen is not ready", async () => {
  db.setSetting("email_provider", "goa");
  expect(ch.emailReady()).toBe(false);
  await expect(ch.emailImapConfig()).rejects.toThrow(/no accounts chosen/);
});

test("GOA provider with unknown account id fails clearly", async () => {
  const run = fakeRun([]);
  db.setSetting("email_provider", "goa");
  db.setSetting("goa_account", "goa_account_9999");
  await expect(ch.emailImapConfig(run)).rejects.toThrow(/not available|none of the configured/i);
});

// ---------- XOAUTH2 against fake servers ----------

function startFakeImapXoauth2(expectBlob: string, ok: boolean) {
  const seen: string[] = [];
  let challenged = false;
  const server = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: {
      open(sock) { sock.write("* OK fake IMAP ready\r\n"); },
      data(sock, data) {
        // NB: do not filter empty lines — the client aborts a failed SASL
        // exchange with a bare CRLF after the "+" challenge.
        const parts = data.toString().split("\r\n");
        for (let i = 0; i < parts.length; i++) {
          const line = parts[i];
          if (line === "" && i === parts.length - 1) continue; // trailing artifact
          seen.push(line === "" ? "<empty>" : line);
          if (challenged && line === "") {
            challenged = false;
            sock.write(`a001 NO invalid token\r\n`);
            continue;
          }
          const m = line.match(/^(\S+)\s+(.*)$/);
          if (!m) continue;
          const [tag, rest] = [m[1], m[2]];
          if (rest.startsWith("AUTHENTICATE XOAUTH2")) {
            const blob = rest.split(" ")[2] || "";
            if (ok && blob === expectBlob) { sock.write(`${tag} OK authenticated\r\n`); }
            else { challenged = true; sock.write(`+ eyJzdGF0dXMiOiI0MDAifQ==\r\n`); }
          } else if (rest.startsWith("SELECT")) { sock.write(`${tag} OK selected\r\n`); }
          else if (rest.startsWith("LOGOUT")) { sock.write(`* BYE\r\n${tag} OK bye\r\n`); sock.end(); }
        }
      },
    },
  });
  return { port: server.port, seen, stop: () => server.stop() };
}

test("IMAP XOAUTH2 login succeeds with a valid token", async () => {
  const blob = imap.xoauth2Blob("ada@gmail.com", "ya29.faketoken");
  const srv = startFakeImapXoauth2(blob, true);
  try {
    const r = await imap.validateImap({ host: "127.0.0.1", port: srv.port, user: "ada@gmail.com", pass: "", xoauth2Token: "ya29.faketoken", secure: false });
    expect(r.ok).toBe(true);
    expect(srv.seen.some((l) => l.startsWith("a001 AUTHENTICATE XOAUTH2 "))).toBe(true);
    expect(srv.seen.some((l) => l.includes("LOGIN"))).toBe(false);
  } finally { srv.stop(); }
});

test("IMAP XOAUTH2 failure aborts fast with a 401 (no hang)", async () => {
  const blob = imap.xoauth2Blob("ada@gmail.com", "badtoken");
  const srv = startFakeImapXoauth2(blob, false);
  const t0 = Date.now();
  try {
    await expect(imap.validateImap({ host: "127.0.0.1", port: srv.port, user: "ada@gmail.com", pass: "", xoauth2Token: "badtoken", secure: false }))
      .rejects.toThrow(/XOAUTH2/);
    expect(Date.now() - t0).toBeLessThan(10000); // fails fast, not the 30s read timeout
  } finally { srv.stop(); }
});

test("SMTP AUTH XOAUTH2 succeeds with a valid token", async () => {
  const { validateSmtp } = await import("../src/smtp.ts");
  const blob = imap.xoauth2Blob("ada@gmail.com", "ya29.faketoken");
  const cmds: string[] = [];
  const server = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: {
      open(sock) { sock.write("220 fake ESMTP\r\n"); },
      data(sock, data) {
        for (const c of data.toString().split("\r\n").filter(Boolean)) {
          cmds.push(c);
          const u = c.toUpperCase();
          if (u.startsWith("EHLO")) sock.write("250-fake\r\n250 AUTH XOAUTH2\r\n");
          else if (u === `AUTH XOAUTH2 ${blob}`.toUpperCase()) sock.write("235 2.7.0 Accepted\r\n");
          else if (u === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
        }
      },
    },
  });
  try {
    const r = await validateSmtp({ host: "127.0.0.1", port: server.port, secure: "none", user: "ada@gmail.com", pass: "", xoauth2Token: "ya29.faketoken", from: "ada@gmail.com" });
    expect(r.ok).toBe(true);
    expect(cmds.some((c) => c.toUpperCase().startsWith("AUTH XOAUTH2"))).toBe(true);
    expect(cmds.some((c) => c.toUpperCase() === "AUTH LOGIN")).toBe(false);
  } finally { server.stop(); }
});

// ---------- multi-account GOA ----------

test("goaAccountIds reads the JSON array and migrates the legacy single key", () => {
  // Empty → none.
  expect(ch.goaAccountIds()).toEqual([]);
  // Legacy single key migrates on first read.
  db.setSetting("goa_account", "goa_account_1001");
  expect(ch.goaAccountIds()).toEqual(["goa_account_1001"]);
  expect(db.getSetting("goa_accounts")).toBe(JSON.stringify(["goa_account_1001"]));
  expect(db.getSetting("goa_account")).toBe("");
  // Canonical array wins over any legacy residue.
  db.setSetting("goa_account", "goa_account_9999");
  expect(ch.goaAccountIds()).toEqual(["goa_account_1001"]);
  // Multiple ids.
  db.setSetting("goa_accounts", JSON.stringify(["goa_account_1001", "goa_account_1002"]));
  expect(ch.goaAccountIds()).toEqual(["goa_account_1001", "goa_account_1002"]);
});

test("goaSendFromId defaults to first, honors explicit choice", () => {
  db.setSetting("goa_accounts", JSON.stringify(["goa_account_1001", "goa_account_1002"]));
  expect(ch.goaSendFromId()).toBe("goa_account_1001");
  db.setSetting("goa_send_from", "goa_account_1002");
  expect(ch.goaSendFromId()).toBe("goa_account_1002");
  // Explicit choice for an unconfigured id falls back to first.
  db.setSetting("goa_send_from", "goa_account_9999");
  expect(ch.goaSendFromId()).toBe("goa_account_1001");
  expect(ch.goaSendFromId()).not.toBeNull();
});

test("goaAccountsOrThrow resolves every configured account", async () => {
  const run = fakeRun([]);
  db.setSetting("email_provider", "goa");
  db.setSetting("goa_accounts", JSON.stringify(["goa_account_1001", "goa_account_1002", "goa_account_1005"]));
  const all = await ch.goaAccountsOrThrow(run);
  expect(all.length).toBe(3);
  expect(all.map((r) => r.acct.email).sort()).toEqual(["ada@gmail.com", "bob@example.com", "erin@gmail.com"]);
  // Per-account provider types cached for the Sent APPEND decision.
  expect(db.getSetting("goa_provider_type:goa_account_1001")).toBe("google");
});

test("goaAccountsOrThrow skips vanished accounts, throws when none remain", async () => {
  const run = fakeRun([]);
  db.setSetting("email_provider", "goa");
  db.setSetting("goa_accounts", JSON.stringify(["goa_account_1001", "goa_account_9999"]));
  const all = await ch.goaAccountsOrThrow(run);
  expect(all.length).toBe(1);
  expect(all[0].acct.id).toBe("goa_account_1001");
  db.setSetting("goa_accounts", JSON.stringify(["goa_account_9999"]));
  await expect(ch.goaAccountsOrThrow(run)).rejects.toThrow(/none of the configured/i);
});

test("emailImapConfig accepts an explicit account id", async () => {
  const run = fakeRun([]);
  db.setSetting("email_provider", "goa");
  db.setSetting("goa_accounts", JSON.stringify(["goa_account_1001", "goa_account_1002"]));
  const ic = await ch.emailImapConfig("goa_account_1002", run);
  expect(ic.host).toBe("imap.example.com");
  expect(ic.user).toBe("bob@example.com");
  expect(ic.pass).toBe("pw-for-imap-password");
  const sc = await ch.emailSmtpConfig("goa_account_1002", run);
  expect(sc.from).toBe("bob@example.com");
});

test("replyFromAccount follows the thread's latest inbound account", async () => {
  db.setSetting("email_provider", "goa");
  db.setSetting("goa_accounts", JSON.stringify(["goa_account_1001", "goa_account_1002"]));
  const c = db.createContact({ name: "Zed", email: "zed@example.com" });
  const conv = db.conversationFor(c.id);
  // Inbound arrived on the second account → reply from the second.
  db.addMessage({ conversation_id: conv.id, channel: "email", direction: "in", body: "hi", via: "goa_account_1002" });
  expect(ch.replyFromAccount(c.id)).toBe("goa_account_1002");
  // No inbound → default send-from (first).
  const c2 = db.createContact({ name: "Yan", email: "yan@example.com" });
  expect(ch.replyFromAccount(c2.id)).toBe("goa_account_1001");
  // Explicit send-from wins the default.
  db.setSetting("goa_send_from", "goa_account_1002");
  expect(ch.replyFromAccount(c2.id)).toBe("goa_account_1002");
  // But the thread's account still wins over the default.
  expect(ch.replyFromAccount(c.id)).toBe("goa_account_1002");
});

test("providerAutoSavesSent is per-account for GOA", () => {
  db.setSetting("email_provider", "goa");
  db.setSetting("goa_accounts", JSON.stringify(["goa_account_1001", "goa_account_1002"]));
  db.setSetting("goa_provider_type:goa_account_1001", "google");
  db.setSetting("goa_provider_type:goa_account_1002", "imap_smtp");
  expect(ch.providerAutoSavesSent("goa_account_1001")).toBe(true);
  expect(ch.providerAutoSavesSent("goa_account_1002")).toBe(false);
});

test("ingestEmail tags messages with the receiving account", () => {
  const report = { email: 0, sms: 0, matrix: 0, encrypted: 0, unknown: 0 };
  const c = db.createContact({ name: "Zoe", email: "zoe@example.com" });
  ch.ingestEmail({
    uid: "u1", from: "Zoe <zoe@example.com>", to: [], subject: "hey",
    date: "", dateTime: "2026-10-14T00:00:00Z", snippet: "hi", body: "hi",
    returnPath: "", messageId: "mid-1", viaAccount: "goa_account_1005",
  }, report);
  const conv = db.conversationFor(c.id);
  const msgs = db.listMessages(conv.id);
  expect(msgs.length).toBe(1);
  expect(msgs[0].via).toBe("goa_account_1005");
  expect(report.email).toBe(1);
});
