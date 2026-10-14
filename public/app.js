// outpost frontend — modern iMessage-style client
const $ = (id) => document.getElementById(id);
const api = async (path, opts = {}) => {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && j.error) throw new Error(j.error);
  return j;
};

const CHAN_LABEL = { email: "Email", sms: "SMS", matrix: "Matrix", encrypted: "🔒 Encrypted" };
const CHAN_PH = { email: "Email", sms: "Text Message", matrix: "Matrix message", encrypted: "Encrypted message" };
const CHIPS = [
  { id: "all", label: "All" },
  { id: "needs_reply", label: "Needs reply" },
  { id: "personal", label: "Personal" },
  { id: "newsletter", label: "Newsletters" },
  { id: "receipt", label: "Receipts" },
  { id: "automated", label: "Automated" },
];
const state = { view: "list", tab: "inbox", convs: [], thread: null, channel: null, editing: null, q: "", chip: "all", nudges: [], inbox: null, email: null, secCollapsed: { newsletter: true, receipt: true, automated: true }, selecting: false, selected: new Set(), inboxUnread: 0 };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const initials = (n) => n.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || "").join("") || "?";
const hueOf = (n) => [...n].reduce((a, c) => a + c.codePointAt(0), 0) % 360;
const avatarStyle = (n) => {
  const h = hueOf(n || "?");
  return `background:linear-gradient(135deg,hsl(${h},42%,58%),hsl(${(h + 30) % 360},48%,42%))`;
};
const fmtTime = (iso) => {
  if (!iso) return "";
  const d = new Date(iso), now = new Date();
  const day = (x) => x.getFullYear() + "-" + x.getMonth() + "-" + x.getDate();
  if (day(d) === day(now)) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M/i, (m) => m.trim());
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (day(d) === day(yest)) return "Yesterday";
  return d.toLocaleDateString([], { month: "numeric", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "2-digit" });
};
const fmtDay = (iso) => new Date(iso).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
const sameDay = (a, b) => fmtDay(a) === fmtDay(b);

function show(view) {
  state.view = view;
  for (const v of ["list", "thread", "form", "settings", "nudges", "email"]) $("view-" + v).hidden = v !== view;
  $("topbar").style.display = view === "list" ? "" : "none";
}

async function loadConversations() {
  const { conversations } = await api("/api/conversations");
  state.convs = conversations;
  renderList();
  updateMood();
}

async function loadReplyLater() {
  const { items } = await api("/api/reply-later");
  state.laterItems = items || [];
  renderReplyLater();
}

function renderReplyLater() {
  const list = $("later-list");
  const items = state.laterItems || [];
  if (!items.length) {
    list.innerHTML = `<div class="empty">Nothing parked for later.<br><span style="font-size:13px">Tap the ⏰ on any message to park it here.</span></div>`;
    return;
  }
  list.innerHTML = `<div class="section-label" style="margin:8px 4px">Reply later · ${items.length}</div>` + items.map((m) => `
    <div class="conv" data-id="${m.conversation_id}">
      <div class="avatar" style="${avatarStyle(m.contact_name)}">${esc(initials(m.contact_name))}</div>
      <div class="meta">
        <div class="row1"><h3>${esc(m.contact_name)}</h3><time>${fmtTime(m.created_at)}</time></div>
        <p><span class="chanpill">⏰ later</span>${m.subject ? `<span class="subj">${esc(m.subject)}</span>` : ""}${esc((m.body || "").slice(0, 80))}</p>
      </div>
    </div>`).join("");
  list.querySelectorAll(".conv").forEach((el) =>
    el.addEventListener("click", () => openThread(el.dataset.id)));
}

function renderChips() {
  $("chips").innerHTML = CHIPS.map((c) =>
    `<button data-chip="${c.id}" class="${c.id === state.chip ? "on" : ""}">${c.label}</button>`).join("");
  $("chips").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => { state.chip = b.dataset.chip; renderChips(); renderList(); }));
}

function renderList() {
  renderChips();
  const q = state.q.trim().toLowerCase();
  const needReply = new Set(state.nudges.filter((n) => n.kind === "reply_needed").map((n) => n.conversation_id));
  const list = $("conv-list");
  const rows = state.convs.filter((c) => {
    if (q && !(c.contact_name.toLowerCase().includes(q) || (c.last_body || "").toLowerCase().includes(q))) return false;
    if (state.chip === "needs_reply") return needReply.has(c.id);
    if (state.chip !== "all") return (c.category || "personal") === state.chip;
    return true;
  });
  if (!rows.length) {
    list.innerHTML = `<div class="empty">${state.chip === "all" ? "No conversations yet.<br>Tap ＋ to add someone from outside the 8." : "Nothing here."}</div>`;
    return;
  }
  $("conv-list").classList.toggle("selecting", state.selecting);
  list.innerHTML = rows.map((c) => {
    const cat = c.category || "personal";
    const catpill = cat !== "personal" && c.last_email_msg
      ? `<button class="chanpill catbtn" data-mid="${c.last_email_msg}" data-cat="${cat}">${cat}</button>` : "";
    const laterpill = c.reply_later_count > 0
      ? `<span class="chanpill" title="${c.reply_later_count} parked for later">⏰${c.reply_later_count > 1 ? " " + c.reply_later_count : ""}</span>` : "";
    const sel = state.selected.has(c.id);
    return `
    <div class="conv${c.unread ? " unread" : ""}${sel ? " sel" : ""}" data-id="${c.id}">
      ${state.selecting ? `<div class="selcircle${sel ? " on" : ""}">${sel ? "✓" : ""}</div>` : ""}
      <div class="dot"><i></i></div>
      <div class="avatar" style="${avatarStyle(c.contact_name)}">${esc(initials(c.contact_name))}</div>
      <div class="meta">
        <div class="row1"><h3>${esc(c.contact_name)}</h3>${needReply.has(c.id) ? '<span style="color:var(--accent);font-size:13px;font-weight:700">needs reply</span>' : ""}<time>${fmtTime(c.last_at)}</time></div>
        <p>${c.last_channel ? `<span class="chanpill">${c.last_channel}</span>` : ""}${catpill}${laterpill}${esc((c.last_body || "").slice(0, 80)) || "<i>No messages yet</i>"}</p>
      </div>
    </div>`;
  }).join("");
  list.querySelectorAll(".conv").forEach((el) =>
    el.addEventListener("click", () => state.selecting ? toggleSelect(el.dataset.id) : openThread(el.dataset.id)));
  list.querySelectorAll(".catbtn").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    openTriageSheet(b.dataset.mid, b.dataset.cat);
  }));
}

// ---------- multi-select delete conversations ----------
function enterSelect() {
  state.selecting = true; state.selected = new Set();
  $("btn-select").textContent = "Done";
  $("btn-new-contact").style.display = "none";
  $("selbar").hidden = false;
  updateSelbar(); renderList();
}
function exitSelect() {
  if (!state.selecting) return;
  state.selecting = false; state.selected = new Set();
  $("btn-select").textContent = "Select";
  $("btn-new-contact").style.display = state.tab === "chats" ? "" : "none";
  $("selbar").hidden = true;
  renderList();
}
function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  updateSelbar(); renderList();
}
function updateSelbar() {
  const n = state.selected.size;
  $("sel-count").textContent = n ? `${n} selected` : "Tap conversations to select";
  $("sel-delete").disabled = !n;
}
$("btn-select").addEventListener("click", () => state.selecting ? exitSelect() : enterSelect());
$("sel-cancel").addEventListener("click", exitSelect);
$("sel-delete").addEventListener("click", async () => {
  const ids = [...state.selected];
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} conversation${ids.length === 1 ? "" : "s"}? The message history will be removed. Contacts are kept.`)) return;
  const r = await api("/api/conversations", { method: "DELETE", body: JSON.stringify({ ids }) });
  toast(`Deleted ${r.deleted} conversation${r.deleted === 1 ? "" : "s"}.`);
  exitSelect(); loadConversations();
});

async function loadUnknown() {
  const { unknown } = await api("/api/unknown");
  const strip = $("unknown-strip");
  if (!unknown.length) { strip.hidden = true; strip.innerHTML = ""; return; }
  strip.hidden = false;
  strip.innerHTML = `<div class="unk-head">Unknown senders · ${unknown.length}</div>` +
    unknown.map((u) => `
    <div class="unknown-card" data-id="${u.id}">
      <div class="who">${esc(u.name || u.handle)} <span class="chanpill">${u.channel}</span></div>
      <div class="prev">${esc(u.last_body.slice(0, 110))}</div>
      <div class="acts"><button data-act="promote">Add to Contacts</button><button class="dim" data-act="dismiss">Ignore</button></div>
    </div>`).join("");
  strip.querySelectorAll(".unknown-card").forEach((card) => {
    card.querySelectorAll("button").forEach((b) => b.addEventListener("click", async () => {
      const id = card.dataset.id;
      if (b.dataset.act === "dismiss") { await api(`/api/unknown/${id}/dismiss`, { method: "POST" }); }
      else {
        const name = prompt("Name for this contact:", card.querySelector(".who").textContent.trim()) || "";
        const { contact } = await api(`/api/unknown/${id}/promote`, { method: "POST", body: JSON.stringify({ name }) });
        openContactForm(contact);
        return;
      }
      loadUnknown(); loadConversations();
    }));
  });
}

async function openThread(convId) {
  const { conversation, contact, messages, channels } = await api(`/api/conversations/${convId}`);
  const switching = !state.thread || state.thread.conversation.id !== convId;
  state.thread = { conversation, contact, messages };
  // Never clobber the user's channel pick on refresh — only default when
  // opening a different thread or when the pick is no longer available.
  state.channel = resolveChannel(channels, state.channel, switching);
  $("thread-name").textContent = contact.name;
  $("thread-avatar").textContent = initials(contact.name);
  $("thread-avatar").style.cssText = avatarStyle(contact.name);
  renderThread();
  show("thread");
  loadConversations();
}

function renderThread() {
  const { messages } = state.thread;
  const box = $("messages");
  let html = "", lastDay = "", lastKey = "", lastChan = "";
  messages.forEach((m, i) => {
    const day = fmtDay(m.created_at);
    if (day !== lastDay) { html += `<div class="day">${day}</div>`; lastDay = day; }
    if (m.channel !== lastChan) { html += `<div class="chancap">${CHAN_LABEL[m.channel] || m.channel}</div>`; }
    const key = m.direction;
    const gap = i > 0 ? new Date(m.created_at).getTime() - new Date(messages[i - 1].created_at).getTime() : Infinity;
    const first = key !== lastKey || gap > 5 * 60e3;
    const nx = messages[i + 1];
    const last = !nx || nx.direction !== key || new Date(nx.created_at).getTime() - new Date(m.created_at).getTime() > 5 * 60e3;
    const cls = `msg ${m.direction}${first ? " first" : ""}${last ? " last" : ""}`;
    const laterBtn = `<button class="laterbtn${m.reply_later ? " on" : ""}" data-mid="${m.id}" title="${m.reply_later ? "Unpark" : "Reply later"}">⏰</button>`;
    html += `<div class="${cls}">${m.subject ? `<span class="subj">${esc(m.subject)}</span>` : ""}${esc(m.body)}${laterBtn}</div>`;
    if (last && m.direction === "out" && i === messages.length - 1)
      html += `<div class="delivered">Delivered</div>`;
    lastKey = key; lastChan = m.channel;
  });
  box.innerHTML = html || `<div class="empty">No messages yet.</div>`;
  box.scrollTop = box.scrollHeight;
  box.querySelectorAll(".laterbtn").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const on = !b.classList.contains("on");
    b.classList.toggle("on", on);
    b.title = on ? "Unpark" : "Reply later";
    try {
      await api(`/api/messages/${b.dataset.mid}/reply-later`, { method: "POST", body: JSON.stringify({ on }) });
      // keep the in-memory message in sync so re-renders don't flip it back
      const mm = state.thread.messages.find((x) => x.id === b.dataset.mid);
      if (mm) mm.reply_later = on ? 1 : 0;
      toast(on ? "Parked for later." : "Unparked.");
    } catch (err) {
      b.classList.toggle("on", !on);
      toast("Couldn't update. Try again.");
    }
  }));
  buildChanTabs();
}

function buildChanTabs() {
  const c = state.thread.contact;
  const avail = [];
  if (c.email) avail.push("email");
  if (c.phone) avail.push("sms");
  if (c.matrix_id) avail.push("matrix");
  if (c.e2ee_handle) avail.push("encrypted");
  if (!avail.includes(state.channel)) state.channel = avail[0] || null;
  const tabs = $("chan-tabs");
  tabs.hidden = avail.length < 2;
  tabs.innerHTML = avail.map((ch) =>
    `<button data-ch="${ch}" class="${ch === state.channel ? "on" : ""}">${CHAN_LABEL[ch]}</button>`).join("");
  tabs.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => { state.channel = b.dataset.ch; buildChanTabs(); syncComposer(); }));
  syncComposer();
}

function syncComposer() {
  const hasText = $("compose-text").value.trim().length > 0;
  $("btn-send").hidden = !hasText;
  $("compose-text").placeholder = state.channel ? CHAN_PH[state.channel] : "Message";
}

$("compose-text").addEventListener("input", syncComposer);
$("btn-send").addEventListener("click", sendMessage);
$("compose-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
async function sendMessage() {
  const text = $("compose-text").value.trim();
  if (!text || !state.channel || !state.thread) return;
  $("btn-send").disabled = true;
  try {
    const r = await api(`/api/conversations/${state.thread.conversation.id}/send`,
      { method: "POST", body: JSON.stringify({ channel: state.channel, body: text }) });
    if (!r.ok) throw new Error(r.error || "send failed");
    $("compose-text").value = "";
    syncComposer();
    await openThread(state.thread.conversation.id);
  } catch (e) { alert("Couldn't send: " + e.message); }
  finally { $("btn-send").disabled = false; }
}

$("btn-back").addEventListener("click", () => { state.thread = null; show("list"); refresh(); });
$("thread-title").addEventListener("click", () => {
  if (state.thread) openContactForm(state.thread.contact);
});
$("search").addEventListener("input", (e) => {
  state.q = e.target.value;
  if (state.tab === "inbox") renderInbox(); else renderList();
});
$("btn-poll").addEventListener("click", async () => {
  const b = $("btn-poll");
  b.style.transform = "rotate(180deg)";
  try {
    const r = await api("/api/poll", { method: "POST" });
    await refresh();
    toast(pollSummary(r.lastPoll?.report));
  } catch (e) { toast("Poll failed: " + e.message); }
  finally { setTimeout(() => b.style.transform = "", 400); }
});

let toastTimer = null;
function toast(msg, ms = 4500) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

function pollSummary(rep) {
  if (!rep) return "Checked.";
  if (rep.error) return "⚠ " + rep.error;
  const parts = [];
  const n = (rep.email || 0) + (rep.unknown || 0);
  if (n) parts.push(n + (n === 1 ? " new email" : " new emails"));
  if (rep.encrypted) parts.push(rep.encrypted + (rep.encrypted === 1 ? " encrypted message" : " encrypted messages"));
  if (rep.sms) parts.push(rep.sms + " SMS");
  if (rep.matrix) parts.push(rep.matrix + " Matrix");
  if (rep.backfilled && !rep.backfilled.error) {
    const b = (rep.backfilled.email || 0) + (rep.backfilled.unknown || 0);
    if (b) parts.push("imported " + b + " recent");
  }
  if (rep.backfilled?.error) parts.push("import failed: " + rep.backfilled.error);
  if (rep.triaged) parts.push(rep.triaged + " organized");
  if (rep.reorganized) parts.push(rep.reorganized + " relabeled");
  return parts.length ? parts.join(" · ") : "No new mail.";
}

// ---------- triage learning: correct a label, see why ----------
const TRIAGE_CATS = ["personal", "newsletter", "receipt", "automated"];

function closeSheet() { $("sheet-wrap").hidden = true; }
$("sheet-cancel").addEventListener("click", closeSheet);
$("sheet-wrap").addEventListener("click", (e) => { if (e.target === $("sheet-wrap")) closeSheet(); });

async function openTriageSheet(messageId, current) {
  $("sheet-title").textContent = "Organize";
  $("sheet-body").innerHTML = `<div style="padding:20px 16px;color:var(--muted)">Loading…</div>`;
  $("sheet-wrap").hidden = false;
  let t;
  try {
    t = await api("/api/triage/explain?messageId=" + encodeURIComponent(messageId));
  } catch (e) {
    $("sheet-body").innerHTML = `<div style="padding:20px 16px;color:var(--muted)">Couldn't load categories. Try again.</div>`;
    return;
  }
  const srcName = t.source === "model" ? "learned model" : t.source === "user" ? "you corrected this" : t.source === "userrule" ? "your rule" : t.source === "llm" ? "local LLM" : "rules";
  $("sheet-title").textContent = `Labeled "${t.category}" · ${srcName}`;
  const why = t.source === "model" && t.evidence.length
    ? `<div style="padding:8px 16px 4px;font-size:13px;color:var(--muted)">Because: ${t.evidence.slice(0, 3).map((e) => `${esc(e.feature)} (${e.weight >= 0 ? "+" : ""}${e.weight.toFixed(1)})`).join(", ")}</div>`
    : `<div style="padding:8px 16px 4px;font-size:13px;color:var(--muted)">${esc(t.reason)}</div>`;
  $("sheet-body").innerHTML = why + TRIAGE_CATS.map((c) =>
    `<button class="sheet-btn${c === current ? " on" : ""}" data-cat="${c}">${c[0].toUpperCase() + c.slice(1)}${c === current ? " ✓" : ""}</button>`).join("");
  $("sheet-body").querySelectorAll("button").forEach((b) => b.addEventListener("click", async () => {
    if (b.dataset.cat === current) { closeSheet(); return; }
    // step 2: scope — this email only, or a standing rule for the sender?
    const cat = b.dataset.cat;
    const sender = t.from_email || "";
    $("sheet-title").textContent = `Label as "${cat}"`;
    $("sheet-body").innerHTML =
      `<div style="padding:8px 16px 4px;font-size:13px;color:var(--muted)">Apply to:</div>` +
      `<button class="sheet-btn" data-scope="one">Just this email</button>` +
      (sender.includes("@") ? `<button class="sheet-btn" data-scope="sender">All mail from ${esc(sender)}</button>` : "");
    $("sheet-body").querySelectorAll("button").forEach((s) => s.addEventListener("click", async () => {
      const r = await api(`/api/triage/${messageId}/correct`, { method: "POST", body: JSON.stringify({ category: cat, scope: s.dataset.scope }) });
      closeSheet();
      await refresh();
      if (state.view === "email" && state.email?.id === messageId) openEmail(messageId); // re-render reader
      toast(r.reorganized
        ? `Inbox reorganized — ${r.reorganized} email${r.reorganized === 1 ? "" : "s"} moved.`
        : r.rule ? `Rule saved: all mail from ${r.rule} → ${cat}.` : "Label updated.");
    }));
  }));
}

// ---------- inbox: 30 days of email, organized by the agent ----------
const SECTIONS = [
  { id: "personal", label: "Personal" },
  { id: "newsletter", label: "Newsletters" },
  { id: "receipt", label: "Receipts" },
  { id: "automated", label: "Automated" },
];

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll("#main-seg button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $("inbox-pane").hidden = tab !== "inbox";
  $("chats-pane").hidden = tab !== "chats";
  $("later-pane").hidden = tab !== "later";
  $("btn-new-contact").style.display = tab === "chats" && !state.selecting ? "" : "none";
  $("btn-select").style.display = tab === "chats" ? "" : "none";
  if (tab !== "chats") exitSelect();
  if (tab === "inbox") loadInbox(); else if (tab === "later") loadReplyLater(); else loadConversations();
}
document.querySelectorAll("#main-seg button").forEach((b) =>
  b.addEventListener("click", () => setTab(b.dataset.tab)));

async function loadInbox() {
  const r = await api("/api/inbox");
  state.inbox = r.sections;
  state.priority = r.priority || [];
  state.inboxUnread = r.unread || 0;
  renderInbox();
  updateMood();
}
function renderPriority() {
  const items = (state.priority || []).filter((p) => !state.q.trim() || matchInbox(p, state.q.trim().toLowerCase()));
  if (!items.length) return "";
  const bubbles = items.map((p) => {
    const name = senderName(p);
    const first = name.split(/\s+/)[0] || name;
    return `<button class="pbub" data-id="${p.id}" title="${esc(name)} · ${esc(p.why.join(", "))}">
      <span class="pav" style="${avatarStyle(name)}">${esc(initials(name))}</span>
      <span class="pname">${esc(first)}</span>
      <span class="pdot"></span>
    </button>`;
  }).join("");
  return `<div class="prio"><div class="prio-h">Read now <span>· the agent's top picks</span></div>
    <div class="prio-row">${bubbles}</div></div>`;
}

function senderName(r) {
  return r.contact_name || r.from_name || r.from_email;
}

function matchInbox(r, q) {
  return !q || (r.from_email || "").toLowerCase().includes(q) ||
    (r.from_name || "").toLowerCase().includes(q) || (r.contact_name || "").toLowerCase().includes(q) ||
    (r.subject || "").toLowerCase().includes(q) || (r.body || "").toLowerCase().includes(q);
}

/** Pure: which channel should be active after (re)opening a thread?
 *  Refreshes must never clobber the user's pick (the 15s auto-refresh
 *  used to flip "encrypted" back to the first channel). */
function resolveChannel(channels, current, switching) {
  if (switching || !channels.includes(current)) return channels[0] || null;
  return current;
}
function renderInbox() {
  const q = state.q.trim().toLowerCase();
  const list = $("inbox-list");
  const match = (r) => matchInbox(r, q);
  const html = renderPriority() + SECTIONS.map((s) => {
    const rows = (state.inbox?.[s.id] || []).filter(match);
    if (!rows.length) return "";
    const unread = rows.filter((r) => !r.read).length;
    const collapsed = state.secCollapsed[s.id];
    const body = collapsed ? "" : rows.map((r) => `
      <div class="mailrow${r.read ? "" : " unread"}" data-id="${r.id}">
        <div class="dot"><i></i></div>
        <div class="meta">
          <div class="row1"><h3>${esc(senderName(r))}</h3><time>${fmtTime(r.at)}</time></div>
          <div class="subj">${esc(r.subject) || "<i>(no subject)</i>"}</div>
          <p class="snip">${esc((r.body || "").slice(0, 160))}</p>
        </div>
      </div>`).join("");
    return `<div class="inbox-sec">
      <button class="inbox-sec-h" data-sec="${s.id}">${s.label} <span class="count">· ${rows.length}${unread ? ` · ${unread} new` : ""}</span><span class="chev">${collapsed ? "›" : "⌄"}</span></button>
      ${body}</div>`;
  }).join("");
  list.innerHTML = html || `<div class="empty">No email in the last 30 days.<br>
    <span style="font-size:13px">The poller only sees unread mail — tap below to import<br>everything recent, read or not.</span><br><br>
    <button id="btn-backfill" class="primary" style="padding:10px 22px">Import recent mail</button></div>`;
  $("btn-backfill")?.addEventListener("click", async () => {
    toast("Importing recent mail…", 10000);
    try {
      const r = await api("/api/inbox/backfill", { method: "POST" });
      if (!r.ok) throw new Error(r.error || "import failed");
      const n = (r.email || 0) + (r.unknown || 0);
      toast(n ? `Imported ${n} emails.` : "Nothing new to import.");
    } catch (e) { toast("Import failed: " + e.message); }
    loadInbox();
  });
  list.querySelectorAll(".inbox-sec-h").forEach((b) => b.addEventListener("click", () => {
    state.secCollapsed[b.dataset.sec] = !state.secCollapsed[b.dataset.sec];
    renderInbox();
  }));
  list.querySelectorAll(".mailrow").forEach((el) =>
    el.addEventListener("click", () => openEmail(el.dataset.id)));
  list.querySelectorAll(".pbub").forEach((el) =>
    el.addEventListener("click", () => openEmail(el.dataset.id)));
}

function openEmail(id) {
  const all = SECTIONS.flatMap((s) => state.inbox?.[s.id] || []);
  const r = all.find((x) => x.id === id);
  if (!r) return;
  state.email = r;
  state.emailHtml = "";
  state.showImages = false;
  const name = senderName(r);
  if (!r.read) { api(`/api/inbox/${id}/read`, { method: "POST", body: JSON.stringify({ read: true }) }); r.read = 1; }
  $("email-body").innerHTML = `
    <div class="email-subject">${esc(r.subject) || "(no subject)"}</div>
    <div class="email-from">
      <div class="avatar" style="${avatarStyle(name)}">${esc(initials(name))}</div>
      <div class="who"><b>${esc(name)}</b><span>${esc(r.from_email)}</span></div>
      <button class="chanpill catbtn" id="email-cat">${esc(r.category)}</button>
      <div class="email-date">${fmtTime(r.at)}</div>
    </div>
    <div class="email-viewtoggle" id="email-viewtoggle" hidden>
      <button id="email-view-rich" class="on">Rich</button><button id="email-view-text">Text</button>
      <button id="email-show-images" class="dim" hidden>Show images</button>
    </div>
    <div class="email-text" id="email-text">${esc(r.body)}</div>
    <iframe class="email-html" id="email-html" hidden sandbox="" title="Email content"></iframe>
    <div class="email-actions">
      ${r.contact_id ? `<button id="email-open-chat">Open chat</button>` : `<button id="email-add-contact">Add to Contacts</button>`}
      <button id="email-toggle-read" class="dim">${r.read ? "Mark unread" : "Mark read"}</button>
      <button id="email-delete" class="dim">Delete</button>
    </div>`;
  // Try to load the rich HTML version; fall back to plain text silently.
  (async () => {
    try {
      const { html } = await api(`/api/inbox/${id}/html`);
      if (!html || !html.trim()) return;
      state.emailHtml = html;
      $("email-viewtoggle").hidden = false;
      showEmailHtml(false);
      $("email-view-rich").addEventListener("click", () => showEmailHtml(state.showImages));
      $("email-view-text").addEventListener("click", showEmailText);
      $("email-show-images").addEventListener("click", () => {
        state.showImages = true;
        showEmailHtml(true);
      });
    } catch { /* plain text remains */ }
  })();

function showEmailText() {
  $("email-text").hidden = false;
  $("email-html").hidden = true;
  $("email-view-rich")?.classList.remove("on");
  $("email-view-text")?.classList.add("on");
  $("email-show-images").hidden = true;
}

function showEmailHtml(withImages) {
  let html = state.emailHtml || "";
  let blocked = 0;
  if (!withImages) {
    // Block remote images (tracking pixels); keep data:/cid: embeds.
    html = html.replace(/<img\b[^>]*>/gi, (tag) => {
      const srcM = tag.match(/\ssrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i);
      const raw = srcM ? srcM[1].replace(/^["']|["']$/g, "") : "";
      if (/^(data:image\/|cid:)/i.test(raw.trim())) return tag;
      const altM = tag.match(/\salt\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i);
      const alt = altM ? altM[1].replace(/^["']|["']$/g, "").replace(/</g, "&lt;") : "image";
      return `<span style="display:inline-block;border:1px dashed #999;border-radius:6px;padding:4px 8px;font-size:12px;color:#666">🖼 ${alt}</span>`;
    });
  }
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;max-width:100%;overflow-wrap:break-word;padding:8px;margin:0}img{max-width:100%;height:auto}a{color:#0066cc}</style></head><body>${html}</body></html>`;
  const frame = $("email-html");
  frame.hidden = false;
  $("email-text").hidden = true;
  frame.srcdoc = doc;
  // Auto-size the iframe to its content.
  frame.onload = () => {
    try {
      const h = frame.contentDocument?.body?.scrollHeight;
      if (h) frame.style.height = Math.min(h + 20, 2000) + "px";
    } catch { /* sandboxed — keep default height */ }
  };
  $("email-view-rich")?.classList.add("on");
  $("email-view-text")?.classList.remove("on");
  const btn = $("email-show-images");
  btn.hidden = blocked === 0 && withImages;
  btn.textContent = blocked ? `Show images (${blocked} blocked)` : "Show images";
}
  $("email-add-contact")?.addEventListener("click", () => {
    openContactForm(null);
    $("f-name").value = r.from_name || "";
    $("f-email").value = r.from_email || "";
  });
  $("email-cat").addEventListener("click", () => openTriageSheet(id, r.category));
  $("email-open-chat")?.addEventListener("click", async () => {
    const { conversations } = await api("/api/conversations");
    const conv = conversations.find((c) => c.contact_id === r.contact_id);
    if (conv) openThread(conv.id);
  });
  $("email-toggle-read").addEventListener("click", async () => {
    await api(`/api/inbox/${id}/read`, { method: "POST", body: JSON.stringify({ read: !!r.read }) });
    r.read = r.read ? 0 : 1;
    openEmail(id);
    loadInbox();
  });
  $("email-delete").addEventListener("click", async () => {
    if (!confirm("Delete this email?")) return;
    await api(`/api/inbox/${id}`, { method: "DELETE" });
    show("list"); loadInbox();
  });
  show("email");
}
$("btn-email-back").addEventListener("click", () => { show("list"); loadInbox(); });
const KIND_LABEL = { reply_needed: "Reply", follow_up: "Follow up", unknown_waiting: "New sender" };

async function loadNudges() {
  const { nudges } = await api("/api/nudges");
  state.nudges = nudges;
  const badge = $("nudge-badge");
  badge.hidden = !nudges.length;
  badge.textContent = nudges.length > 9 ? "9+" : nudges.length;
  updateMood();
  if (state.view === "list") renderList(); // refresh "needs reply" markers
  $("nudge-list").innerHTML = nudges.map((n) => `
    <div class="nudge-card" data-id="${n.id}">
      <div class="kind">${KIND_LABEL[n.kind] || n.kind}</div>
      <h3>${esc(n.title)}</h3>
      <p>${esc(n.detail)}</p>
      <div class="acts">
        ${n.conversation_id ? `<button data-act="open">Open thread</button>` : ""}
        <button data-act="snooze">Snooze 3d</button>
        <button class="dim" data-act="dismiss">Dismiss</button>
      </div>
    </div>`).join("") || `<div class="empty">All clear — nothing needs your attention.</div>`;
  $("nudge-list").querySelectorAll(".nudge-card").forEach((card) => {
    card.querySelectorAll("button").forEach((b) => b.addEventListener("click", async () => {
      const id = card.dataset.id;
      const n = state.nudges.find((x) => x.id === id);
      if (b.dataset.act === "open" && n?.conversation_id) {
        await api(`/api/nudges/${id}/acted`, { method: "POST" }); // useful → learn
        openThread(n.conversation_id);
        return;
      }
      if (b.dataset.act === "snooze") await api(`/api/nudges/${id}/snooze`, { method: "POST", body: JSON.stringify({ days: 3 }) });
      else await api(`/api/nudges/${id}/dismiss`, { method: "POST" });
      await refresh();
    }));
  });
}
$("btn-nudges").addEventListener("click", () => { show("nudges"); loadNudges(); });
$("btn-nudges-back").addEventListener("click", () => { show("list"); refresh(); });

// ---------- contacts ----------
$("btn-contacts").addEventListener("click", async () => {
  const { contacts } = await api("/api/contacts");
  state.view = "contacts";
  const list = $("conv-list");
  $("search").value = ""; state.q = "";
  list.innerHTML = `
    <div style="padding:10px 16px 2px"><button id="btn-import-vcf" class="navbtn" style="padding:8px 0">Import from vCard (.vcf)</button></div>
    <input type="file" id="vcf-file" accept=".vcf,.vcard,text/vcard" hidden>` +
    contacts.map((c) => `
    <div class="conv" data-cid="${c.id}">
      <div class="dot"><i></i></div>
      <div class="avatar" style="${avatarStyle(c.name)}">${esc(initials(c.name))}</div>
      <div class="meta"><div class="row1"><h3>${esc(c.name)}</h3></div>
      <p>${esc([c.email, c.phone, c.matrix_id].filter(Boolean).join(" · "))}</p></div>
    </div>`).join("") || `<div class="empty">No contacts yet — tap ＋ to add one.</div>`;
  list.insertAdjacentHTML("beforeend",
    `<div style="padding:24px 16px 40px;text-align:center"><button id="btn-clear-contacts" class="destruct">Clear All Contacts</button></div>`);
  $("btn-import-vcf").addEventListener("click", () => $("vcf-file").click());
  $("vcf-file").addEventListener("change", importVcfFile);
  $("btn-clear-contacts").addEventListener("click", async () => {
    if (!confirm("Delete ALL contacts, conversations, and messages? This can't be undone.")) return;
    if (!confirm("Last chance — really wipe everything? Your channel settings will be kept.")) return;
    const r = await api("/api/contacts/clear", { method: "POST" });
    alert(`Cleared ${r.cleared.contacts} contacts, ${r.cleared.messages} messages.`);
    $("btn-contacts").click();
  });
  list.querySelectorAll(".conv").forEach((el) =>
    el.addEventListener("click", async () => {
      const { contacts: cs } = await api("/api/contacts");
      openContactForm(cs.find((x) => x.id === el.dataset.cid));
    }));
  show("list");
  $("unknown-strip").hidden = true;
});
$("btn-new-contact").addEventListener("click", () => openContactForm(null));

async function importVcfFile(e) {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const text = await f.text();
    const r = await api("/api/contacts/import", { method: "POST", body: JSON.stringify({ vcf: text }) });
    const bits = [`Imported ${r.imported.length} of ${r.total}`];
    if (r.skipped.length) bits.push(`${r.skipped.length} skipped (${r.skipped.filter((s) => s.reason === "duplicate").length} already here)`);
    alert(bits.join(" · "));
  } catch (err) { alert("Import failed: " + err.message); }
  e.target.value = "";
  $("btn-contacts").click();
}

function openContactForm(c) {
  state.editing = c?.id || null;
  $("form-title").textContent = c ? "Edit Contact" : "New Contact";
  $("f-name").value = c?.name || ""; $("f-email").value = c?.email || "";
  $("f-phone").value = c?.phone || ""; $("f-matrix").value = c?.matrix_id || "";
  $("f-e2ee").value = c?.e2ee_handle || "";
  $("f-notes").value = c?.notes || ""; $("f-room").value = c?.matrix_room || "";
  $("btn-archive").hidden = !c;
  $("safety-row").hidden = !(c?.e2ee_handle);
  $("tout-safety").textContent = "";
  show("form");
}
$("btn-safety").addEventListener("click", async () => {
  if (!state.editing) return;
  $("tout-safety").textContent = "…";
  try {
    const r = await api(`/api/contacts/${state.editing}/safety`);
    $("tout-safety").textContent = r.ok ? r.safetyNumber : "✗ " + (r.error || "");
  } catch (e) { $("tout-safety").textContent = "✗ " + e.message; }
});
$("btn-form-back").addEventListener("click", () => { show("list"); refresh(); });
$("contact-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    name: $("f-name").value, email: $("f-email").value, phone: $("f-phone").value,
    matrix_id: $("f-matrix").value, e2ee_handle: $("f-e2ee").value,
    notes: $("f-notes").value, matrix_room: $("f-room").value,
  };
  if (state.editing) await api(`/api/contacts/${state.editing}`, { method: "PUT", body: JSON.stringify(payload) });
  else await api("/api/contacts", { method: "POST", body: JSON.stringify(payload) });
  show("list"); refresh();
});
$("btn-archive").addEventListener("click", async () => {
  if (!state.editing || !confirm("Archive this contact?")) return;
  await api(`/api/contacts/${state.editing}`, { method: "PUT", body: JSON.stringify({ archived: 1 }) });
  show("list"); refresh();
});

// ---------- settings ----------
$("btn-settings").addEventListener("click", async () => {
  const s = await api("/api/settings");
  for (const k of ["imap_host", "imap_port", "imap_user", "smtp_host", "smtp_port", "smtp_user", "smtp_from", "matrix_homeserver", "e2ee_url", "e2ee_handle", "llm_url", "llm_model", "llm_threshold", "llm_timeout"])
    $("s-" + k).value = s.values[k] || "";
  $("s-llm_enabled").checked = s.values["llm_enabled"] === "1";
  $("s-smtp_secure").value = s.values["smtp_secure"] || "";
  $("s-email_provider").value = s.values["email_provider"] || "manual";
  await loadGoaAccounts(s.values["goa_accounts"] || "[]", s.values["goa_send_from"] || "");
  $("s-imap_pass").value = ""; $("s-smtp_pass").value = ""; $("s-matrix_token").value = ""; $("s-e2ee_token").value = "";
  for (const [k, v] of [["email", s.email_configured], ["sms", s.sms_configured], ["matrix", s.matrix_configured], ["e2ee", s.e2ee_configured], ["llm", s.llm_configured]]) {
    const el = $("cfg-" + k);
    el.textContent = v ? "on" : "off";
    el.className = "cfgdot" + (v ? " yes" : "");
  }
  renderRulesList();
  show("settings");
});

async function renderRulesList() {
  const box = $("rules-list");
  try {
    const { rules } = await api("/api/triage/rules");
    if (!rules.length) {
      box.innerHTML = `<div style="padding:11px 0;font-size:15px;color:var(--muted)">No rules yet — correct a label to teach the agent.</div>`;
      return;
    }
    box.innerHTML = rules.map((r) =>
      `<div class="testrow"><span>${r.source === "llm" ? "🤖 " : ""}All mail from <b>${esc(r.scope === "domain" ? "@" + r.pattern : r.pattern)}</b> → ${esc(r.category)}${r.source === "llm" ? ' <i style="color:var(--muted)">(learned)</i>' : ""}</span><button data-rule="${esc(r.id)}" type="button">Delete</button></div>`).join("");
    box.querySelectorAll("[data-rule]").forEach((b) => b.addEventListener("click", async () => {
      await api("/api/triage/rules/" + encodeURIComponent(b.dataset.rule), { method: "DELETE" });
      renderRulesList();
      toast("Rule deleted.");
    }));
  } catch { box.innerHTML = `<div style="padding:11px 0;font-size:15px;color:var(--muted)">Couldn't load rules.</div>`; }
}
$("btn-settings-back").addEventListener("click", () => { show("list"); refresh(); });
$("btn-save-settings").addEventListener("click", async () => {
  const payload = {};
  for (const k of ["imap_host", "imap_port", "imap_user", "imap_pass", "smtp_host", "smtp_port", "smtp_secure", "smtp_user", "smtp_pass", "smtp_from", "email_provider", "matrix_homeserver", "matrix_token", "e2ee_url", "e2ee_handle", "e2ee_token", "llm_url", "llm_model", "llm_threshold", "llm_timeout"])
    payload[k] = $("s-" + k).value;
  // Multi-account GOA: checked boxes → JSON array; send-from select as-is.
  payload["goa_accounts"] = JSON.stringify(
    [...document.querySelectorAll('#goa-accounts input[type="checkbox"]:checked')].map((c) => c.value));
  payload["goa_send_from"] = $("s-goa_send_from").value || "";
  payload["llm_enabled"] = $("s-llm_enabled").checked ? "1" : "0";
  for (const k of ["imap_pass", "smtp_pass", "matrix_token", "e2ee_token"]) if (!payload[k]) delete payload[k];
  await api("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
  $("btn-settings").click();
});
function updateMailProviderUI() {
  const goa = $("s-email_provider").value === "goa";
  $("goa-box").hidden = !goa;
  $("manual-mail").hidden = goa;
}
$("s-email_provider").addEventListener("change", () => {
  updateMailProviderUI();
  // (Re)load the account list when switching to GOA — otherwise the picker
  // keeps whatever the settings page happened to fetch on open (or nothing).
  if ($("s-email_provider").value === "goa") loadGoaAccounts();
});

async function loadGoaAccounts(savedJson, savedSendFrom) {
  updateMailProviderUI();
  const box = $("goa-accounts");
  const note = $("goa-note");
  const sendSel = $("s-goa_send_from");
  $("btn-goa-test").disabled = true;
  let selected = [];
  try { selected = JSON.parse(savedJson || "[]"); } catch { selected = []; }
  if (!Array.isArray(selected)) selected = [];
  // When re-loading (provider switch), keep the current checkbox state.
  if (savedJson === undefined) {
    selected = [...box.querySelectorAll('input[type="checkbox"]:checked')].map((c) => c.value);
    savedSendFrom = sendSel.value;
  }
  const renderSendFrom = (accounts) => {
    const cur = savedSendFrom || "";
    sendSel.innerHTML = `<option value="">First selected</option>` + accounts
      .filter((a) => selected.includes(a.id))
      .map((a) => `<option value="${esc(a.id)}"${a.id === cur ? " selected" : ""}>${esc(a.email)}</option>`).join("");
  };
  try {
    const r = await api("/api/goa/accounts");
    if (!r.available) {
      box.innerHTML = `<p class="sectnote">Not available</p>`;
      note.textContent = "GNOME Online Accounts isn't reachable (no GNOME session or goa-daemon not running).";
      return;
    }
    if (!r.accounts.length) {
      box.innerHTML = `<p class="sectnote">No mail accounts</p>`;
      note.textContent = "No GNOME accounts with Mail enabled. Add one in GNOME Settings → Online Accounts.";
      return;
    }
    box.innerHTML = r.accounts.map((a) =>
      `<label class="goa-check"><input type="checkbox" value="${esc(a.id)}"${selected.includes(a.id) ? " checked" : ""}>` +
      `<span>${esc(a.email)} <em>(${esc(a.providerName)})</em></span></label>`).join("");
    box.querySelectorAll('input[type="checkbox"]').forEach((c) =>
      c.addEventListener("change", () => {
        selected = [...box.querySelectorAll('input[type="checkbox"]:checked')].map((x) => x.value);
        renderSendFrom(r.accounts);
      }));
    renderSendFrom(r.accounts);
    $("btn-goa-test").disabled = false;
    note.textContent = "Uses your GNOME Online Accounts — tokens stay in the GNOME keyring, outpost never stores them. Replies go out from the account that received the thread.";
  } catch (e) {
    box.innerHTML = `<p class="sectnote">Couldn't load</p>`;
    note.textContent = "Couldn't reach GNOME Online Accounts: " + e.message;
  }
}
$("btn-goa-test").addEventListener("click", async () => {
  const out = $("tout-goa");
  out.textContent = "…"; out.className = "testout";
  try {
    const ids = [...document.querySelectorAll('#goa-accounts input[type="checkbox"]:checked')].map((c) => c.value);
    if (!ids.length) { out.textContent = "✗ select at least one account"; out.className = "testout err"; return; }
    const results = [];
    for (const id of ids) {
      const r = await api("/api/goa/test", { method: "POST", body: JSON.stringify({ account_id: id }) });
      results.push((r.ok ? "✓ " : "✗ ") + (r.email || id) + (r.ok ? "" : ": " + (r.error || "")));
    }
    const okAll = results.every((x) => x.startsWith("✓"));
    out.textContent = results.join(" · ");
    out.className = "testout " + (okAll ? "ok" : "err");
  } catch (e) { out.textContent = "✗ " + e.message; out.className = "testout err"; }
});
document.querySelectorAll("[data-test]").forEach((b) => b.addEventListener("click", async () => {
  const out = $("tout-" + b.dataset.test);
  out.textContent = "…"; out.className = "testout";
  try {
    const r = await api(`/api/settings/test/${b.dataset.test}`, { method: "POST" });
    out.textContent = r.ok ? "✓" : "✗ " + (r.error || "");
    out.className = "testout " + (r.ok ? "ok" : "err");
  } catch (e) { out.textContent = "✗ " + e.message; out.className = "testout err"; }
}));
$("btn-test-llm").addEventListener("click", async () => {
  const out = $("tout-llm");
  out.textContent = "…"; out.className = "testout";
  try {
    const r = await api("/api/llm/status");
    if (!r.reachable) { out.textContent = "✗ " + (r.error || ""); out.className = "testout err"; return; }
    const model = $("s-llm_model").value.trim();
    if (r.model_found === false) {
      out.textContent = `✗ model "${model}" is not pulled — ollama pull ${model}`;
      out.className = "testout err"; return;
    }
    if (r.supports_generate === false) {
      out.textContent = `✗ "${model}" is embedding-only and can't judge mail — use a chat model`;
      out.className = "testout err"; return;
    }
    out.textContent = `✓ ${r.models?.length ? r.models.slice(0, 3).join(", ") : "reachable"}`;
    out.className = "testout ok";
  } catch (e) { out.textContent = "✗ " + e.message; out.className = "testout err"; }
});

async function refresh() {
  if (state.view === "contacts") { $("btn-contacts").click(); return; }
  if (state.view === "nudges") { loadNudges(); return; }
  if (state.view === "email") { loadInbox(); return; }
  if (state.tab === "inbox") await loadInbox();
  else if (state.tab === "later") await loadReplyLater();
  else { await loadConversations(); await loadUnknown(); }
  await loadNudges();
}
setInterval(() => { if (state.view === "list") refresh(); }, 30_000);
setInterval(() => { if (state.view === "thread" && state.thread) openThread(state.thread.conversation.id); }, 15_000);

// ---------- 16-bit mood scene: system state as pixel art ----------
// Light theme: daytime streetscape — houses and people scale with activity
// (unread messages + nudges). Dark theme: night beach — stars scale with
// activity. Animates only as feedback for changing system state; static
// otherwise. Honors prefers-reduced-motion.
const MOOD_PX = 4, MOOD_GW = 30, MOOD_GH = 16;
const mood = { unread: -1, nudges: -1, dark: false, raf: 0, layoutKey: "", layout: null };
const MOOD_REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;var t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function moodLayout(dark, activity){
  const key = (dark ? "n" : "d") + activity;
  if(mood.layoutKey === key) return mood.layout;
  const rnd = mulberry32(activity * 7919 + 101);
  const L = { clouds: [], houses: [], people: [], stars: [], waves: [] };
  if(!dark){
    const nC = 2 + Math.floor(rnd() * 2);
    for(let i = 0; i < nC; i++) L.clouds.push({ x: Math.floor(rnd() * 26), y: 1 + Math.floor(rnd() * 3) });
    const nH = 2 + Math.min(3, Math.floor(activity / 4));
    const bodies = ["#e07a5f", "#f2cc8f", "#81b29d", "#f4f1de", "#e9c46a"];
    const roofs = ["#9d0208", "#6d6875", "#7f4f24", "#5e503f", "#9d0208"];
    for(let i = 0; i < nH; i++){
      const x = i * 6;
      if(x + 5 > 30) break;
      L.houses.push({ x, body: bodies[i % 5], roof: roofs[i % 5] });
    }
    const nP = Math.min(6, activity);
    const shirts = ["#e63946", "#457b9d", "#2a9d8f", "#f4a261", "#9d4edd", "#e9c46a"];
    for(let i = 0; i < nP; i++) L.people.push({ x: Math.floor(rnd() * 30), shirt: shirts[i % 6], speed: 1 + (i % 2) });
  } else {
    const nS = 10 + Math.min(50, activity * 3);
    for(let i = 0; i < nS; i++) L.stars.push({ x: Math.floor(rnd() * 30), y: Math.floor(rnd() * 9), warm: rnd() < 0.25 });
    for(let i = 0; i < 3; i++) L.waves.push({ x: Math.floor(rnd() * 26) });
  }
  mood.layoutKey = key; mood.layout = L; return L;
}
function moodDraw(dark, activity, frame){
  const cv = $("mood"); if(!cv) return;
  const g = cv.getContext("2d");
  const R = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(Math.round(x * MOOD_PX), Math.round(y * MOOD_PX), Math.ceil(w * MOOD_PX), Math.ceil(h * MOOD_PX)); };
  const L = moodLayout(dark, activity);
  if(!dark){
    R(0, 0, 30, 3, "#79c7f2"); R(0, 3, 30, 3, "#a5ddfb"); R(0, 6, 30, 2, "#d3eefd");
    R(24, 1, 3, 3, "#ffd60a");
    R(25, 0, 1, 1, "#ffea70"); R(23, 2, 1, 1, "#ffea70"); R(27, 2, 1, 1, "#ffea70"); R(25, 4, 1, 1, "#ffea70");
    const drift = frame > 0 ? Math.floor(frame / 12) : 0;
    for(const c of L.clouds){
      const x = (((c.x + drift) % 34) + 34) % 34 - 2;
      R(x, c.y, 5, 1, "#ffffff"); R(x + 1, c.y + 1, 3, 1, "#f1f8ff");
    }
    for(const h of L.houses){
      R(h.x + 3, 7, 1, 2, "#8d99ae");
      R(h.x + 1, 8, 3, 1, h.roof); R(h.x, 9, 5, 1, h.roof);
      R(h.x, 10, 5, 2, h.body);
      R(h.x + 2, 10, 1, 2, "#5e503f");
      R(h.x, 10, 1, 1, "#caf0f8"); R(h.x + 4, 10, 1, 1, "#caf0f8");
    }
    R(0, 12, 30, 1, "#74a12e");
    R(0, 13, 30, 2, "#6c757d");
    for(let x = 1; x < 29; x += 4) R(x, 13, 2, 1, "#dee2e6");
    R(0, 15, 30, 1, "#adb5bd");
    for(let i = 0; i < L.people.length; i++){
      const p = L.people[i];
      const x = frame > 0 ? (((p.x + Math.floor(frame / 8) * p.speed) % 32) + 32) % 32 - 1 : p.x;
      const step = frame > 0 && (Math.floor(frame / 6) + i) % 2 === 0;
      R(x, 14, 1, 1, step ? "#2b2d42" : "#343a40");
      R(x, 13, 1, 1, p.shirt);
      R(x, 12, 1, 1, "#f1c27d");
    }
  } else {
    R(0, 0, 30, 4, "#0b132b"); R(0, 4, 30, 3, "#141c3f"); R(0, 7, 30, 3, "#1c2541");
    R(3, 1, 3, 3, "#f8f9fa"); R(4, 2, 1, 1, "#dee2e6"); R(3, 3, 1, 1, "#e9ecef");
    for(let i = 0; i < L.stars.length; i++){
      const st = L.stars[i];
      const tw = frame > 0 && ((i + Math.floor(frame / 8)) % 6 === 0);
      R(st.x, st.y, 1, 1, tw ? "#fff3b0" : (st.warm ? "#ffe66d" : "#e0fbfc"));
    }
    R(0, 10, 30, 2, "#1d3557");
    for(const w of L.waves) R(w.x, 10, 3, 1, "#457b9d");
    const shim = frame > 0 ? (((frame >> 3) % 2) === 0 ? "#e0fbfc" : "#98c1d9") : "#98c1d9";
    R(3, 10, 2, 1, shim); R(4, 11, 1, 1, shim);
    R(0, 12, 30, 1, "#e9d8a6"); R(0, 13, 30, 3, "#d4a373");
    R(24, 7, 5, 1, "#40916c");
    R(22, 8, 8, 1, "#2d6a4f");
    R(22, 9, 2, 1, "#2d6a4f"); R(28, 9, 2, 1, "#2d6a4f");
    R(25, 9, 1, 1, "#6f4518");
    R(26, 9, 1, 2, "#9c6644"); R(26, 11, 1, 4, "#9c6644");
    if(frame > 0){
      const nSt = 1 + (activity >= 8 ? 1 : 0);
      for(let s = 0; s < nSt; s++){
        const ph = (((frame / 70) + s * 0.55) % 1 + 1) % 1;
        const hx = 32 - ph * 38, hy = 1 + ph * 7;
        for(let k = 0; k < 5; k++){
          R(hx + k, hy + k * 0.5, 1, 1, k === 0 ? "#ffffff" : "rgba(224,251,252," + (1 - k / 5).toFixed(2) + ")");
        }
      }
    }
  }
}
function moodPulse(){
  if(mood.raf) cancelAnimationFrame(mood.raf);
  const t0 = performance.now(), DUR = 2600, act = mood.unread + mood.nudges, dark = mood.dark;
  const tick = (t) => {
    const el = t - t0;
    if(el >= DUR){ moodDraw(dark, act, 0); mood.raf = 0; return; }
    moodDraw(dark, act, 1 + Math.floor(el / 60));
    mood.raf = requestAnimationFrame(tick);
  };
  mood.raf = requestAnimationFrame(tick);
}
function updateMood(){
  const cv = $("mood"); if(!cv) return;
  const chatUnread = (state.convs || []).reduce((s, c) => s + (c.unread || 0), 0);
  const unread = chatUnread + (state.inboxUnread || 0);
  const nudges = (state.nudges || []).length;
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const changed = unread !== mood.unread || nudges !== mood.nudges || dark !== mood.dark;
  const first = mood.unread < 0;
  mood.unread = unread; mood.nudges = nudges; mood.dark = dark;
  moodDraw(dark, unread + nudges, 0);
  cv.setAttribute("aria-label", "System mood: " + unread + " unread, " + nudges + " nudges");
  if(changed && !first && !MOOD_REDUCED && !document.hidden) moodPulse();
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", updateMood);

setTab("inbox");
loadNudges();
