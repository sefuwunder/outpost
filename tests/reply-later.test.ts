// reply-later tagging: set, list, clear on reply.
import { test, expect, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OUTPOST_DATA = join(tmpdir(), `outpost-test-${process.pid}-${Math.random().toString(36).slice(2)}`);

const db = await import("../src/db.ts");

beforeEach(() => {
  db.openDb(join(process.env.OUTPOST_DATA!, `t-${Math.random().toString(36).slice(2)}.db`));
});

function seed() {
  const c = db.createContact({ name: "Ada" });
  const conv = db.conversationFor(c.id);
  const m1 = db.addMessage({ conversation_id: conv.id, channel: "sms", direction: "in", body: "call me", subject: "", external_id: "e1", created_at: new Date().toISOString() });
  const m2 = db.addMessage({ conversation_id: conv.id, channel: "sms", direction: "in", body: "urgent", subject: "", external_id: "e2", created_at: new Date().toISOString() });
  return { c, conv, m1: m1!.id, m2: m2!.id };
}

test("setReplyLater tags and untags a message", () => {
  const { m1 } = seed();
  db.setReplyLater(m1, true);
  let items = db.listReplyLater();
  expect(items.length).toBe(1);
  expect(items[0].id).toBe(m1);
  expect(items[0].contact_name).toBe("Ada");
  db.setReplyLater(m1, false);
  expect(db.listReplyLater().length).toBe(0);
});

test("clearReplyLaterForConversation clears tags on reply", () => {
  const { conv, m1, m2 } = seed();
  db.setReplyLater(m1, true);
  db.setReplyLater(m2, true);
  expect(db.listReplyLater().length).toBe(2);
  db.clearReplyLaterForConversation(conv.id);
  expect(db.listReplyLater().length).toBe(0);
});

test("listConversations reports reply_later_count", () => {
  const { conv, m1 } = seed();
  db.setReplyLater(m1, true);
  const convs = db.listConversations();
  const row = convs.find((c: any) => c.id === conv.id) as any;
  expect(row.reply_later_count).toBe(1);
});

test("listMessages includes reply_later flag", () => {
  const { conv, m1 } = seed();
  db.setReplyLater(m1, true);
  const msgs = db.listMessages(conv.id);
  const msg = msgs.find((x) => x.id === m1)!;
  expect(msg.reply_later).toBe(1);
});
