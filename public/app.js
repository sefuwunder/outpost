// outpost frontend — modern iMessage-style client
const $ = (id) => document.getElementById(id);
const api = async (path, opts = {}) => {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && j.error) throw new Error(j.error);
  return j;
};

const CHAN_LABEL = { email: "Email", sms: "SMS", matrix: "Matrix" };
const CHAN_PH = { email: "Email", sms: "Text Message", matrix: "Matrix message" };
const state = { view: "list", convs: [], thread: null, channel: null, editing: null, q: "" };

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
  for (const v of ["list", "thread", "form", "settings"]) $("view-" + v).hidden = v !== view;
  $("topbar").style.display = view === "list" ? "" : "none";
}

async function loadConversations() {
  const { conversations } = await api("/api/conversations");
  state.convs = conversations;
  renderList();
}

function renderList() {
  const q = state.q.trim().toLowerCase();
  const list = $("conv-list");
  const rows = state.convs.filter((c) =>
    !q || c.contact_name.toLowerCase().includes(q) || (c.last_body || "").toLowerCase().includes(q));
  if (!rows.length) {
    list.innerHTML = `<div class="empty">No conversations yet.<br>Tap ＋ to add someone from outside the 8.</div>`;
    return;
  }
  list.innerHTML = rows.map((c) => `
    <div class="conv${c.unread ? " unread" : ""}" data-id="${c.id}">
      <div class="dot"><i></i></div>
      <div class="avatar" style="${avatarStyle(c.contact_name)}">${esc(initials(c.contact_name))}</div>
      <div class="meta">
        <div class="row1"><h3>${esc(c.contact_name)}</h3><time>${fmtTime(c.last_at)}</time></div>
        <p>${c.last_channel ? `<span class="chanpill">${c.last_channel}</span>` : ""}${esc((c.last_body || "").slice(0, 80)) || "<i>No messages yet</i>"}</p>
      </div>
    </div>`).join("");
  list.querySelectorAll(".conv").forEach((el) =>
    el.addEventListener("click", () => openThread(el.dataset.id)));
}

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
  state.thread = { conversation, contact, messages };
  state.channel = channels[0] || null;
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
    html += `<div class="${cls}">${m.subject ? `<span class="subj">${esc(m.subject)}</span>` : ""}${esc(m.body)}</div>`;
    if (last && m.direction === "out" && i === messages.length - 1)
      html += `<div class="delivered">Delivered</div>`;
    lastKey = key; lastChan = m.channel;
  });
  box.innerHTML = html || `<div class="empty">No messages yet.</div>`;
  box.scrollTop = box.scrollHeight;
  buildChanTabs();
}

function buildChanTabs() {
  const c = state.thread.contact;
  const avail = [];
  if (c.email) avail.push("email");
  if (c.phone) avail.push("sms");
  if (c.matrix_id) avail.push("matrix");
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

$("btn-back").addEventListener("click", () => { state.thread = null; show("list"); loadConversations(); });
$("thread-title").addEventListener("click", () => {
  if (state.thread) openContactForm(state.thread.contact);
});
$("search").addEventListener("input", (e) => { state.q = e.target.value; renderList(); });
$("btn-poll").addEventListener("click", async () => {
  const b = $("btn-poll");
  b.style.transform = "rotate(180deg)";
  try { await api("/api/poll", { method: "POST" }); await refresh(); }
  finally { setTimeout(() => b.style.transform = "", 400); }
});

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
  $("btn-import-vcf").addEventListener("click", () => $("vcf-file").click());
  $("vcf-file").addEventListener("change", importVcfFile);
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
  $("f-notes").value = c?.notes || ""; $("f-room").value = c?.matrix_room || "";
  $("btn-archive").hidden = !c;
  show("form");
}
$("btn-form-back").addEventListener("click", () => { show("list"); refresh(); });
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
  for (const [k, v] of [["email", s.email_configured], ["sms", s.sms_configured], ["matrix", s.matrix_configured]]) {
    const el = $("cfg-" + k);
    el.textContent = v ? "on" : "off";
    el.className = "cfgdot" + (v ? " yes" : "");
  }
  show("settings");
});
$("btn-settings-back").addEventListener("click", () => { show("list"); refresh(); });
$("btn-save-settings").addEventListener("click", async () => {
  const payload = {};
  for (const k of ["imap_host", "imap_port", "imap_user", "imap_pass", "smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_from", "matrix_homeserver", "matrix_token"])
    payload[k] = $("s-" + k).value;
  for (const k of ["imap_pass", "smtp_pass", "matrix_token"]) if (!payload[k]) delete payload[k];
  await api("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
  $("btn-settings").click();
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

async function refresh() {
  if (state.view === "contacts") { $("btn-contacts").click(); return; }
  await loadConversations();
  await loadUnknown();
}
setInterval(() => { if (state.view === "list") refresh(); }, 30_000);
setInterval(() => { if (state.view === "thread" && state.thread) openThread(state.thread.conversation.id); }, 15_000);

refresh();
