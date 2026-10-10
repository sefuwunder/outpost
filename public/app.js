// outpost frontend — conversation-view client
const $ = (id) => document.getElementById(id);
const api = async (path, opts = {}) => {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && j.error) throw new Error(j.error);
  return j;
};

const CHAN_LABEL = { email: "✉️ email", sms: "💬 sms", matrix: "🟣 matrix" };
const state = { view: "list", convs: [], thread: null, channel: null, editing: null, q: "" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const initials = (n) => n.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || "").join("") || "?";
const fmtTime = (iso) => {
  if (!iso) return "";
  const d = new Date(iso), now = new Date();
  const day = (x) => x.getFullYear() + "-" + x.getMonth() + "-" + x.getDate();
  if (day(d) === day(now)) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (day(d) === day(yest)) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
};
const fmtDay = (iso) => new Date(iso).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

function show(view) {
  state.view = view;
  for (const v of ["list", "thread", "form", "settings"]) $("view-" + v).hidden = v !== view;
}

async function loadConversations() {
  const { conversations, unread } = await api("/api/conversations");
  state.convs = conversations;
  const pill = $("unread-pill");
  pill.hidden = !unread;
  pill.textContent = unread > 99 ? "99+" : unread;
  renderList();
}

function renderList() {
  const q = state.q.trim().toLowerCase();
  const list = $("conv-list");
  const rows = state.convs.filter((c) =>
    !q || c.contact_name.toLowerCase().includes(q) || (c.last_body || "").toLowerCase().includes(q));
  if (!rows.length) {
    list.innerHTML = `<div class="empty">No conversations yet.<br>Add someone from outside the 8 with ＋ and start a thread.</div>`;
    return;
  }
  list.innerHTML = rows.map((c) => `
    <div class="conv" data-id="${c.id}">
      <div class="avatar">${esc(initials(c.contact_name))}</div>
      <div class="meta">
        <div class="row1"><h3>${esc(c.contact_name)}</h3>${c.contact_starred ? '<span class="star">★</span>' : ""}<time>${fmtTime(c.last_at)}</time></div>
        <p>${c.last_channel ? `<span class="chan ${c.last_channel}">${c.last_channel}</span> ` : ""}${esc((c.last_body || "").slice(0, 90)) || "<i>no messages yet</i>"}</p>
      </div>
      ${c.unread ? `<div class="ubadge">${c.unread}</div>` : ""}
    </div>`).join("");
  list.querySelectorAll(".conv").forEach((el) =>
    el.addEventListener("click", () => openThread(el.dataset.id)));
}

async function loadUnknown() {
  const { unknown } = await api("/api/unknown");
  const strip = $("unknown-strip");
  if (!unknown.length) { strip.hidden = true; strip.innerHTML = ""; return; }
  strip.hidden = false;
  strip.innerHTML = `<div style="font-size:12px;font-weight:700;color:var(--pine);margin-bottom:6px;letter-spacing:1px">NEW · ${unknown.length} UNKNOWN ${unknown.length === 1 ? "SENDER" : "SENDERS"}</div>` +
    unknown.map((u) => `
    <div class="unknown-card" data-id="${u.id}">
      <b>${esc(u.name || u.handle)}</b> <span class="chan ${u.channel}">${u.channel}</span>
      <div style="color:var(--muted);margin-top:4px">${esc(u.last_body.slice(0, 120))}</div>
      <div class="acts"><button class="go" data-act="promote">＋ Save as contact</button><button data-act="dismiss">Dismiss</button></div>
    </div>`).join("");
  strip.querySelectorAll(".unknown-card").forEach((card) => {
    card.querySelectorAll("button").forEach((b) => b.addEventListener("click", async () => {
      const id = card.dataset.id;
      if (b.dataset.act === "dismiss") { await api(`/api/unknown/${id}/dismiss`, { method: "POST" }); }
      else {
        const name = prompt("Name for this contact:", card.querySelector("b").textContent) || "";
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
  state.thread = { conversation, contact, messages };
  state.channel = channels[0] || null;
  $("thread-name").textContent = contact.name;
  $("thread-sub").textContent = [contact.email, contact.phone, contact.matrix_id].filter(Boolean).join(" · ") || "no channels yet";
  renderThread();
  show("thread");
  loadConversations(); // refresh unread badges
}

function renderThread() {
  const { messages } = state.thread;
  const box = $("messages");
  let lastDay = "";
  box.innerHTML = messages.map((m) => {
    const day = fmtDay(m.created_at);
    const dh = day !== lastDay ? `<div class="day">${day}</div>` : "";
    lastDay = day;
    return `${dh}<div class="msg ${m.direction}">
      ${m.subject ? `<span class="subj">${esc(m.subject)}</span>` : ""}${esc(m.body)}
      <div class="meta"><span class="chan ${m.channel}">${m.channel}</span><span>${fmtTime(m.created_at)}</span></div>
    </div>`;
  }).join("") || `<div class="empty">No messages yet — say hello.</div>`;
  box.scrollTop = box.scrollHeight;
  buildChanTabs();
}

function buildChanTabs() {
  // channels were returned by openThread; recompute from contact
  const c = state.thread.contact;
  const avail = [];
  if (c.email) avail.push("email");
  if (c.phone) avail.push("sms");
  if (c.matrix_id) avail.push("matrix");
  if (!avail.includes(state.channel)) state.channel = avail[0] || null;
  const tabs = $("chan-tabs");
  tabs.innerHTML = avail.map((ch) =>
    `<button data-ch="${ch}" class="${ch === state.channel ? "on" : ""}">${CHAN_LABEL[ch]}</button>`).join("")
    || `<span style="font-size:13px;color:var(--muted)">Add an email, phone, or Matrix ID to message them.</span>`;
  tabs.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => { state.channel = b.dataset.ch; buildChanTabs(); }));
}

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
    await openThread(state.thread.conversation.id);
  } catch (e) { alert("Send failed: " + e.message); }
  finally { $("btn-send").disabled = false; }
}

$("btn-back").addEventListener("click", () => { state.thread = null; show("list"); loadConversations(); });
$("search").addEventListener("input", (e) => { state.q = e.target.value; renderList(); });
$("btn-poll").addEventListener("click", async () => {
  $("btn-poll").disabled = true;
  try { await api("/api/poll", { method: "POST" }); await refresh(); }
  finally { $("btn-poll").disabled = false; }
});

// ---------- contacts ----------
$("btn-contacts").addEventListener("click", async () => {
  const { contacts } = await api("/api/contacts");
  state.view = "contacts";
  // reuse list view chrome for the contacts roster
  const list = $("conv-list");
  $("search").value = ""; state.q = "";
  list.innerHTML = contacts.map((c) => `
    <div class="conv" data-cid="${c.id}">
      <div class="avatar">${esc(initials(c.name))}</div>
      <div class="meta"><div class="row1"><h3>${esc(c.name)}</h3>${c.starred ? '<span class="star">★</span>' : ""}</div>
      <p>${esc([c.email, c.phone, c.matrix_id].filter(Boolean).join(" · "))}</p></div>
    </div>`).join("") || `<div class="empty">No contacts yet — add your first with ＋.</div>`;
  list.querySelectorAll(".conv").forEach((el) =>
    el.addEventListener("click", async () => {
      const { contacts: cs } = await api("/api/contacts");
      openContactForm(cs.find((x) => x.id === el.dataset.cid));
    }));
  show("list");
  $("unknown-strip").hidden = true;
});
$("btn-new-contact").addEventListener("click", () => openContactForm(null));

function openContactForm(c) {
  state.editing = c?.id || null;
  $("form-title").textContent = c ? "Edit contact" : "New contact";
  $("f-name").value = c?.name || ""; $("f-email").value = c?.email || "";
  $("f-phone").value = c?.phone || ""; $("f-matrix").value = c?.matrix_id || "";
  $("f-notes").value = c?.notes || "";
  $("f-room").value = c?.matrix_room || "";
  $("btn-archive").hidden = !c;
  show("form");
}
$("btn-form-back").addEventListener("click", () => { show("list"); refresh(); });
$("btn-edit-contact").addEventListener("click", async () => {
  if (!state.thread) return;
  const { contacts } = await api("/api/contacts");
  const c = contacts.find((x) => x.id === state.thread.contact.id);
  // fetch room mapping via a quiet settings read
  openContactForm(c);
});
$("contact-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    name: $("f-name").value, email: $("f-email").value, phone: $("f-phone").value,
    matrix_id: $("f-matrix").value, notes: $("f-notes").value, matrix_room: $("f-room").value,
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
  for (const k of ["imap_host", "imap_port", "imap_user", "smtp_host", "smtp_port", "smtp_user", "smtp_from", "matrix_homeserver"])
    $("s-" + k).value = s.values[k] || "";
  $("s-imap_pass").value = ""; $("s-smtp_pass").value = ""; $("s-matrix_token").value = "";
  $("cfg-email").textContent = s.email_configured ? "● on" : "○ off";
  $("cfg-email").className = "cfg" + (s.email_configured ? " yes" : "");
  $("cfg-sms").textContent = s.sms_configured ? "● on" : "○ off";
  $("cfg-sms").className = "cfg" + (s.sms_configured ? " yes" : "");
  $("cfg-matrix").textContent = s.matrix_configured ? "● on" : "○ off";
  $("cfg-matrix").className = "cfg" + (s.matrix_configured ? " yes" : "");
  show("settings");
});
$("btn-settings-back").addEventListener("click", () => { show("list"); refresh(); });
$("btn-save-settings").addEventListener("click", async () => {
  const payload = {};
  for (const k of ["imap_host", "imap_port", "imap_user", "imap_pass", "smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_from", "matrix_homeserver", "matrix_token"])
    payload[k] = $("s-" + k).value;
  // blank password fields = keep existing
  for (const k of ["imap_pass", "smtp_pass", "matrix_token"]) if (!payload[k]) delete payload[k];
  await api("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
  alert("Saved.");
  $("btn-settings").click();
});
document.querySelectorAll("[data-test]").forEach((b) => b.addEventListener("click", async () => {
  const out = $("tout-" + b.dataset.test);
  out.textContent = "testing…"; out.className = "testout";
  try {
    const r = await api(`/api/settings/test/${b.dataset.test}`, { method: "POST" });
    out.textContent = r.ok ? "✓ works" + (r.userId ? ` (${r.userId})` : "") : "✗ " + (r.error || "failed");
    out.className = "testout " + (r.ok ? "ok" : "err");
  } catch (e) { out.textContent = "✗ " + e.message; out.className = "testout err"; }
}));

async function refresh() {
  if (state.view === "contacts") { $("btn-contacts").click(); return; }
  await loadConversations();
  await loadUnknown();
}
setInterval(() => { if (state.view === "list") refresh(); }, 30_000);
setInterval(() => { if (state.view === "thread" && state.thread) openThread(state.thread.conversation.id); }, 15_000);

refresh();
