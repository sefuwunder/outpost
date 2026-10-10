// smtp tests — secure-mode mapping + STARTTLS-before-AUTH regression test
import { test, expect } from "bun:test";
import { smtpSecureMode, sendMail } from "../src/smtp.ts";

test("smtpSecureMode maps settings and defaults by port", () => {
  expect(smtpSecureMode("", 587)).toBe("starttls");
  expect(smtpSecureMode("", 465)).toBe("ssl");
  expect(smtpSecureMode("", 25)).toBe("starttls");
  expect(smtpSecureMode("starttls", 465)).toBe("starttls"); // explicit wins
  expect(smtpSecureMode("ssl", 587)).toBe("ssl");
  expect(smtpSecureMode("tls", 587)).toBe("starttls");
  expect(smtpSecureMode("none", 587)).toBe("none");
  expect(smtpSecureMode("off", 587)).toBe("none");
  expect(smtpSecureMode("SSL", 587)).toBe("ssl"); // case-insensitive
});

test("starttls mode issues STARTTLS before any AUTH (530 regression)", async () => {
  const cmds: string[] = [];
  // Server answers STARTTLS then hangs up: the client can't complete the TLS
  // upgrade against a fake server, but the command order is what we assert.
  const server = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: {
      open(sock) { sock.write("220 fake ESMTP\r\n"); },
      data(sock, data) {
        for (const c of data.toString().split("\r\n").filter(Boolean)) {
          cmds.push(c);
          const u = c.toUpperCase();
          if (u.startsWith("EHLO")) sock.write("250-fake\r\n250 STARTTLS\r\n");
          else if (u === "STARTTLS") { sock.write("220 go ahead\r\n"); setTimeout(() => sock.end(), 50); }
        }
      },
    },
  });
  let threw = "";
  try {
    await sendMail(
      { host: "127.0.0.1", port: server.port, secure: smtpSecureMode("", 587), user: "u", pass: "p", from: "u@x.com" },
      { to: ["v@x.com"], subject: "s", text: "b" }
    );
  } catch (e: any) { threw = String(e?.message || e); }
  server.stop();
  expect(cmds[0].toUpperCase().startsWith("EHLO")).toBe(true);
  expect(cmds[1].toUpperCase()).toBe("STARTTLS");
  expect(cmds.some((c) => c.toUpperCase().startsWith("AUTH"))).toBe(false);
  expect(threw).not.toContain("530");
});

test("none mode sends without STARTTLS", async () => {
  const cmds: string[] = [];
  const server = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: {
      open(sock) { sock.write("220 fake ESMTP\r\n"); },
      data(sock, data) {
        for (const c of data.toString().split("\r\n").filter(Boolean)) {
          cmds.push(c);
          const u = c.toUpperCase();
          if (u.startsWith("EHLO")) sock.write("250 fake\r\n");
          else if (u === "AUTH LOGIN") sock.write("334 VXNlcm5hbWU6\r\n");
          else if (u === Buffer.from("u").toString("base64").toUpperCase()) sock.write("334 UGFzc3dvcmQ6\r\n");
          else if (u === Buffer.from("p").toString("base64").toUpperCase()) sock.write("235 ok\r\n");
          else if (u.startsWith("MAIL FROM")) sock.write("250 ok\r\n");
          else if (u.startsWith("RCPT TO")) sock.write("250 ok\r\n");
          else if (u === "DATA") sock.write("354 end\r\n");
          else if (u === ".") sock.write("250 queued\r\n");
          else if (u === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
        }
      },
    },
  });
  const r = await sendMail(
    { host: "127.0.0.1", port: server.port, secure: "none", user: "u", pass: "p", from: "u@x.com" },
    { to: ["v@x.com"], subject: "s", text: "b" }
  );
  server.stop();
  expect(r.ok).toBe(true);
  expect(cmds.some((c) => c.toUpperCase() === "STARTTLS")).toBe(false);
  expect(cmds.some((c) => c.toUpperCase().startsWith("AUTH"))).toBe(true);
});
