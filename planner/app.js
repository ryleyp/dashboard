/* Timeblock: Todoist + Google Calendar week planner. Runs entirely in the browser.
   Todoist: REST/Sync API v1 with a personal API token (kept in localStorage).
   Google:  Calendar API v3 with a short-lived access token from Google Identity Services. */
(() => {
"use strict";

// ---------- storage ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const K = {
  todoist: "tb.todoistToken", gclient: "tb.googleClientId", gtoken: "tb.googleToken",
  hidden: "tb.hiddenCalendars", mirror: "tb.mirror", hours: "tb.hours", dur: "tb.durations",
  top3: (d) => "tb.top3." + d, skip: "tb.setupSkipped",
};
const CFG = window.TIMEBLOCK_CONFIG || {};
// The Dungeon dashboard (one folder up, same origin) already keeps the Todoist token
// and Google client ID in "atlas.keys". Reuse them so nothing has to be entered twice.
const ATLAS = LS.get("atlas.keys", {}) || {};
const GOOGLE_SCOPES = "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events";
const TD = "https://api.todoist.com/api/v1/";
const GC = "https://www.googleapis.com/calendar/v3/";

const PROJECT_COLORS = {
  berry_red: "#b8255f", red: "#db4035", orange: "#ff9933", yellow: "#d6a400", olive_green: "#afb83b",
  lime_green: "#7ecc49", green: "#299438", mint_green: "#3fa58a", teal: "#158fad", sky_blue: "#14aaf5",
  light_blue: "#6988a4", blue: "#4073ff", grape: "#884dff", violet: "#af38eb", lavender: "#9e7bc0",
  magenta: "#e05194", salmon: "#ff8d85", charcoal: "#808080", grey: "#9a9a9a", taupe: "#a39382",
};
const PRIO = { 4: "#d1453b", 3: "#eb8909", 2: "#246fe0", 1: "" };

// ---------- state ----------
const S = {
  todoistToken: LS.get(K.todoist, "") || ATLAS.tdtoken || "",
  gClientId: CFG.googleClientId || LS.get(K.gclient, "") || ATLAS.gclient || "",
  gToken: LS.get(K.gtoken, null),
  gtc: null,
  hidden: LS.get(K.hidden, null),
  mirror: LS.get(K.mirror, true),
  hours: LS.get(K.hours, { start: 7, end: 21 }),
  durs: LS.get(K.dur, {}),
  weekOffset: 0,
  selDay: null,
  tasks: [], projects: {}, cals: [], events: [],
  done: new Set(), pending: {},
  err: { todoist: null, google: null },
  loading: { todoist: false, google: false },
  loaded: { todoist: null, google: null },
  scrolled: false,
};

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "style") n.style.cssText = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k in n && typeof v !== "string") n[k] = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtLocal = (d) => `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const mondayOf = (d) => { const x = startOfDay(d); const wd = (x.getDay() + 6) % 7; return addDays(x, -wd); };
const parseDay = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const fmtTime = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fmtHour = (h) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" });
const fmtDur = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? " " + (m % 60) + "m" : ""}` : `${m}m`);
const safeUrl = (u) => (typeof u === "string" && u.startsWith("https://") ? u : null);
const weekStart = () => addDays(mondayOf(new Date()), S.weekOffset * 7);
const todayKey = () => dayKey(new Date());

function toast(msg, ms = 3200) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

// ---------- Todoist ----------
async function td(path, opts = {}) {
  const headers = { Authorization: "Bearer " + S.todoistToken };
  if (opts.json) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(opts.json); }
  let r;
  try { r = await fetch(TD + path, { method: opts.method || (opts.body ? "POST" : "GET"), headers, body: opts.body }); }
  catch { throw { code: "network", message: "Couldn't reach Todoist. Check your connection." }; }
  if (r.status === 401 || r.status === 403) throw { code: "auth", message: "Todoist didn't accept the API token. Paste a fresh one in Settings → Change keys." };
  if (r.status === 429) throw { code: "rate", message: "Todoist is rate limiting requests. Try again in a minute." };
  if (!r.ok) throw { code: "http", message: `Todoist error ${r.status}.` };
  return r.status === 204 ? null : r.json();
}
async function tdAll(path) {
  let out = [], cursor = null, guard = 0;
  do {
    const j = await td(`${path}${path.includes("?") ? "&" : "?"}limit=200${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
    out = out.concat(Array.isArray(j) ? j : j.results || []);
    cursor = Array.isArray(j) ? null : j.next_cursor;
  } while (cursor && ++guard < 25);
  return out;
}
async function tdSync(commands) {
  const body = new URLSearchParams({ commands: JSON.stringify(commands) });
  const j = await td("sync", { method: "POST", body });
  const bad = Object.entries(j.sync_status || {}).find(([, v]) => v !== "ok");
  if (bad) throw { code: "http", message: "Todoist refused the change: " + (bad[1].error || JSON.stringify(bad[1])) };
  return j;
}

async function loadTodoist() {
  if (!S.todoistToken) return;
  S.loading.todoist = true; renderStatus();
  try {
    const [tasks, projects] = await Promise.all([tdAll("tasks"), tdAll("projects")]);
    S.tasks = tasks.filter((t) => !t.checked && !t.is_deleted);
    S.projects = Object.fromEntries(projects.map((p) => [p.id, p]));
    S.err.todoist = null; S.loaded.todoist = new Date();
    S.done = new Set([...S.done].filter((id) => S.tasks.some((t) => t.id === id)));
    for (const [id, p] of Object.entries(S.pending)) if (Date.now() - p.at > 8000) delete S.pending[id];
  } catch (e) { S.err.todoist = e; }
  S.loading.todoist = false;
  render();
}

// task timing
function taskDur(t) {
  const d = t.duration;
  if (d && typeof d === "object" && d.amount) return d.unit === "day" ? d.amount * 1440 : d.amount;
  return S.durs[t.id] || 60;
}
function taskWhen(t) {
  const p = S.pending[t.id];
  if (p) return p.start ? { timed: true, start: new Date(p.start), mins: p.mins } : { timed: false, day: p.day };
  if (!t.due) return null;
  const raw = t.due.datetime || t.due.date;
  if (!raw) return null;
  if (raw.length > 10) return { timed: true, start: new Date(raw), mins: taskDur(t) };
  return { timed: false, day: raw };
}
const whenDay = (w) => (w.timed ? dayKey(w.start) : w.day);
const projColor = (t) => PROJECT_COLORS[S.projects[t.project_id]?.color] || "#808080";
const projName = (t) => S.projects[t.project_id]?.name || "";
const liveTasks = () => S.tasks.filter((t) => !S.done.has(t.id));

async function scheduleTask(t, start, mins) {
  const prev = S.pending[t.id];
  S.pending[t.id] = { start: start.toISOString(), mins, at: Date.now() };
  S.durs[t.id] = mins; LS.set(K.dur, S.durs);
  render();
  const due = { date: fmtLocal(start) };
  if (t.due?.is_recurring) { due.string = t.due.string; due.is_recurring = true; }
  try {
    await tdSync([{ type: "item_update", uuid: crypto.randomUUID(), args: { id: t.id, due, duration: { amount: mins, unit: "minute" } } }]);
    toast(`Blocked ${fmtTime(start)} for “${t.content}”`);
    if (S.mirror && gReady()) mirrorBlock(t, start, mins).catch((e) => toast(e.message || "Couldn't update Google Calendar."));
    loadTodoist();
  } catch (e) {
    if (prev) S.pending[t.id] = prev; else delete S.pending[t.id];
    render(); toast(e.message || "Couldn't reschedule that task.");
  }
}
async function moveTaskToDay(t, day) {
  S.pending[t.id] = { day, at: Date.now() };
  render();
  const due = { date: day };
  if (t.due?.is_recurring) { due.string = t.due.string; due.is_recurring = true; }
  try {
    await tdSync([{ type: "item_update", uuid: crypto.randomUUID(), args: { id: t.id, due } }]);
    toast(`Moved “${t.content}” to ${parseDay(day).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}`);
    loadTodoist();
  } catch (e) { delete S.pending[t.id]; render(); toast(e.message || "Couldn't move that task."); }
}
async function completeTask(t) {
  S.done.add(t.id); markTop3Done(t.id); render();
  try {
    await td(`tasks/${encodeURIComponent(t.id)}/close`, { method: "POST" });
    toast(t.due?.is_recurring ? `Done. “${t.content}” moves to its next date.` : `Completed “${t.content}”`);
    loadTodoist();
  } catch (e) { S.done.delete(t.id); render(); toast(e.message || "Couldn't complete that task."); }
}
async function quickAdd(text) {
  try {
    await td("tasks/quick", { json: { text } });
    toast("Added to Todoist");
    loadTodoist();
    return true;
  } catch (e) { toast(e.message || "Couldn't add that task."); return false; }
}

// ---------- Google ----------
const gReady = () => !!(S.gToken && S.gToken.exp > Date.now());
function gInit() {
  if (S.gtc || !S.gClientId || !window.google?.accounts?.oauth2) return;
  S.gtc = google.accounts.oauth2.initTokenClient({
    client_id: S.gClientId, scope: GOOGLE_SCOPES,
    callback: (resp) => {
      if (resp.error) { S.err.google = { code: "auth", message: "Google sign-in didn't finish." }; render(); return; }
      S.gToken = { t: resp.access_token, exp: Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000 };
      LS.set(K.gtoken, S.gToken); S.err.google = null;
      renderSetup(); loadGoogle();
    },
    error_callback: (err) => { S.err.google = { code: "auth", message: err?.type === "popup_closed" ? "The Google sign-in window was closed." : "Google sign-in was blocked. Allow pop-ups for this site and try again." }; render(); },
  });
  render();
}
window.__gsiReady = gInit;
function gConnect() {
  if (!S.gClientId) { openSetup(); return; }
  gInit();
  if (!S.gtc) { toast("Google sign-in is still loading. Try again in a second."); return; }
  S.gtc.requestAccessToken({ prompt: S.gToken ? "" : "consent" });
}
async function g(path, opts = {}) {
  if (!gReady()) throw { code: "auth", message: "Google sign-in expired." };
  let r;
  try {
    r = await fetch(GC + path, {
      method: opts.method || (opts.json ? "POST" : "GET"),
      headers: { Authorization: "Bearer " + S.gToken.t, ...(opts.json ? { "Content-Type": "application/json" } : {}) },
      body: opts.json ? JSON.stringify(opts.json) : undefined,
    });
  } catch { throw { code: "network", message: "Couldn't reach Google Calendar." }; }
  if (r.status === 401) { S.gToken = null; LS.del(K.gtoken); throw { code: "auth", message: "Google sign-in expired." }; }
  if (r.status === 403) throw { code: "forbidden", message: "Google refused access. Make sure the Calendar API is enabled for your client ID." };
  if (!r.ok) throw { code: "http", message: `Google Calendar error ${r.status}.` };
  return r.status === 204 ? null : r.json();
}
function calHiddenByDefault(c) { return /holiday|birthday/i.test(c.summary || "") || /#holiday|#contacts/.test(c.id); }
function calVisible(c) { return S.hidden ? !S.hidden.includes(c.id) : !calHiddenByDefault(c); }

async function loadGoogle() {
  if (!gReady()) { render(); return; }
  S.loading.google = true; renderStatus();
  try {
    const list = await g("users/me/calendarList?minAccessRole=reader&maxResults=250");
    S.cals = (list.items || []).filter((c) => !c.deleted).sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0) || (a.summaryOverride || a.summary || "").localeCompare(b.summaryOverride || b.summary || ""));
    const ws = weekStart(), we = addDays(ws, 7);
    const q = `timeMin=${encodeURIComponent(ws.toISOString())}&timeMax=${encodeURIComponent(we.toISOString())}&singleEvents=true&orderBy=startTime&maxResults=250`;
    const vis = S.cals.filter(calVisible);
    const results = await Promise.allSettled(vis.map((c) => g(`calendars/${encodeURIComponent(c.id)}/events?${q}`).then((j) => (j.items || []).map((e) => ({ ...e, _cal: c })))));
    S.events = results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).filter((e) => e.status !== "cancelled");
    const failed = results.filter((r) => r.status === "rejected");
    const auth = failed.find((r) => r.reason?.code === "auth");
    S.err.google = auth ? auth.reason : failed.length ? { code: "partial", message: `${failed.length} calendar${failed.length > 1 ? "s" : ""} couldn't load.` } : null;
    S.loaded.google = new Date();
  } catch (e) { S.err.google = e; if (e.code === "auth") S.events = []; }
  S.loading.google = false;
  render();
}
async function mirrorBlock(t, start, mins) {
  const end = new Date(start.getTime() + mins * 60000);
  const found = await g(`calendars/primary/events?privateExtendedProperty=${encodeURIComponent("todoistTaskId=" + t.id)}&maxResults=5`);
  const body = {
    summary: t.content,
    description: "Time block from Todoist. Move it in Timeblock to keep both in step.",
    start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() },
    extendedProperties: { private: { todoistTaskId: String(t.id) } },
    reminders: { useDefault: false }, transparency: "opaque",
  };
  const existing = (found.items || []).find((e) => e.status !== "cancelled");
  if (existing) await g(`calendars/primary/events/${encodeURIComponent(existing.id)}`, { method: "PATCH", json: body });
  else await g("calendars/primary/events", { json: body });
  loadGoogle();
}

// ---------- top 3 ----------
const top3 = () => LS.get(K.top3(todayKey()), []);
function toggleTop3(t) {
  let list = top3();
  if (list.some((x) => x.id === t.id)) list = list.filter((x) => x.id !== t.id);
  else if (list.length >= 3) { toast("You already have three. Unstar one first."); return; }
  else list.push({ id: t.id, content: t.content, done: false });
  LS.set(K.top3(todayKey()), list); render();
}
function markTop3Done(id) { const l = top3(); const x = l.find((i) => i.id === id); if (x) { x.done = true; LS.set(K.top3(todayKey()), l); } }

// ---------- rendering: sidebar ----------
function taskRow(t, opts = {}) {
  const w = taskWhen(t);
  const starred = top3().some((x) => x.id === t.id);
  const meta = [];
  const pn = projName(t);
  if (pn) meta.push(el("span", null, el("i", { class: "dot", style: `background:${projColor(t)}` }), pn));
  if (w?.timed) meta.push(el("span", { text: `${fmtTime(w.start)} · ${fmtDur(w.mins)}` }));
  else if (opts.showDate && w) meta.push(el("span", { text: parseDay(w.day).toLocaleDateString([], { month: "short", day: "numeric" }) }));
  if (t.due?.is_recurring) meta.push(el("span", { text: "↻ " + t.due.string }));
  const li = el("li", { class: "task", draggable: "true", "data-id": t.id },
    el("button", { class: "chk", style: PRIO[t.priority] ? `--prio:${PRIO[t.priority]}` : null, "aria-label": `Complete ${t.content}`, title: "Complete", onclick: (e) => { e.stopPropagation(); completeTask(t); } }),
    el("div", null, el("div", { class: "t-title", text: t.content, onclick: (e) => openTaskPop(t, e.currentTarget) }), meta.length ? el("div", { class: "t-meta" }, meta) : null),
    el("div", { class: "row" },
      opts.today ? el("button", { class: "btn small", text: "Today", title: "Move to today", onclick: () => moveTaskToDay(t, todayKey()) }) : null,
      el("button", { class: "star" + (starred ? " on" : ""), "aria-label": starred ? "Remove from today's three" : "Make this one of today's three", title: "Today's three", text: starred ? "★" : "☆", onclick: () => toggleTop3(t) })),
  );
  wireDrag(li, t);
  return li;
}
function fillList(id, items, countId, opts) {
  const ul = $(id); ul.replaceChildren();
  $(countId).textContent = items.length;
  if (!items.length) ul.append(el("li", { class: "empty-row", text: opts.empty }));
  else items.forEach((t) => ul.append(taskRow(t, opts)));
}
function sortTasks(a, b) {
  const wa = taskWhen(a), wb = taskWhen(b);
  const ka = wa ? (wa.timed ? fmtLocal(wa.start) : wa.day + "T99") : "9999", kb = wb ? (wb.timed ? fmtLocal(wb.start) : wb.day + "T99") : "9999";
  return ka.localeCompare(kb) || b.priority - a.priority || (a.child_order || 0) - (b.child_order || 0);
}
function renderSide() {
  const tk = todayKey();
  const tasks = liveTasks();
  const withWhen = tasks.map((t) => [t, taskWhen(t)]);
  const today = withWhen.filter(([, w]) => w && whenDay(w) === tk).map(([t]) => t).sort(sortTasks);
  const overdue = withWhen.filter(([, w]) => w && whenDay(w) < tk).map(([t]) => t).sort(sortTasks);
  const undated = withWhen.filter(([, w]) => !w).map(([t]) => t).sort((a, b) => b.priority - a.priority);
  const noTd = !S.todoistToken;
  fillList("todayList", today, "todayCount", { empty: noTd ? "Connect Todoist to see tasks." : S.err.todoist ? S.err.todoist.message : "Nothing due today." });
  fillList("overdueList", overdue, "overdueCount", { empty: "Nothing overdue.", today: true, showDate: true });
  fillList("undatedList", undated, "undatedCount", { empty: "Every task has a date." });
  $("overdueCard").hidden = !overdue.length;

  const list = top3();
  const ol = $("top3List"); ol.replaceChildren();
  for (let i = 0; i < 3; i++) {
    const x = list[i];
    if (!x) { ol.append(el("li", { class: "empty", text: "Open slot" }, el("span"), el("span"))); continue; }
    const t = S.tasks.find((y) => y.id === x.id);
    const done = x.done || S.done.has(x.id) || (!t && S.loaded.todoist);
    ol.append(el("li", { class: done ? "done" : "" },
      el("span", { class: "t-title", text: x.content, onclick: (e) => t && openTaskPop(t, e.currentTarget) }),
      done ? el("span", { class: "pill", text: "done" }) : el("button", { class: "chk", "aria-label": `Complete ${x.content}`, onclick: () => t && completeTask(t) })));
  }
  const doneCount = list.filter((x) => x.done || S.done.has(x.id) || (!S.tasks.some((y) => y.id === x.id) && S.loaded.todoist)).length;
  $("top3Count").textContent = `${doneCount} / ${Math.max(3, list.length)}`;
  $("top3Hint").hidden = list.length >= 3;
}

function renderClock() {
  const now = new Date();
  $("clkH").textContent = pad(now.getHours() % 12 || 12);
  $("clkM").textContent = pad(now.getMinutes());
  $("clkDay").textContent = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  const tk = todayKey();
  const meetings = S.events.filter((e) => e.start?.dateTime && dayKey(new Date(e.start.dateTime)) === tk && !e.extendedProperties?.private?.todoistTaskId).length;
  const due = liveTasks().filter((t) => { const w = taskWhen(t); return w && whenDay(w) === tk; }).length;
  const parts = [];
  if (gReady()) parts.push(`${meetings} meeting${meetings === 1 ? "" : "s"}`);
  if (S.todoistToken) parts.push(`${due} task${due === 1 ? "" : "s"} due`);
  $("clkSummary").textContent = parts.join(" · ");
}

function renderStatus() {
  const bits = [];
  if (S.loading.todoist || S.loading.google) bits.push("Syncing…");
  else if (S.loaded.todoist || S.loaded.google) bits.push("Updated " + fmtTime(new Date(Math.max(S.loaded.todoist || 0, S.loaded.google || 0))));
  $("status").textContent = bits.join(" ");
}

function renderBanner() {
  const b = $("banner"); b.replaceChildren();
  const msgs = [];
  if (!S.todoistToken) msgs.push([ "Todoist isn't connected.", "Connect", openSetup ]);
  else if (S.err.todoist) msgs.push([ S.err.todoist.message, S.err.todoist.code === "auth" ? "Change key" : "Retry", S.err.todoist.code === "auth" ? openSetup : loadTodoist ]);
  if (!S.gClientId) msgs.push([ "Google Calendar isn't set up yet.", "Set up", openSetup ]);
  else if (!gReady()) msgs.push([ S.gToken === null && S.loaded.google ? "Google sign-in expired." : "Google Calendar isn't connected on this device.", "Connect Google", gConnect ]);
  else if (S.err.google) msgs.push([ S.err.google.message, "Retry", loadGoogle ]);
  for (const [text, label, fn] of msgs) b.append(el("span", { text }), el("button", { class: "btn small", text: label, onclick: fn }));
  b.hidden = !msgs.length;
}

// ---------- rendering: week grid ----------
const isNarrow = () => window.matchMedia("(max-width: 900px)").matches;
function layoutLanes(items) {
  items.sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [], clusterEnd = -1;
  const flush = () => { const n = Math.max(...cluster.map((i) => i.lane)) + 1; cluster.forEach((i) => (i.lanes = n)); cluster = []; };
  for (const it of items) {
    if (cluster.length && it.s >= clusterEnd) flush(), (clusterEnd = -1);
    const used = new Set(cluster.filter((c) => c.e > it.s).map((c) => c.lane));
    let lane = 0; while (used.has(lane)) lane++;
    it.lane = lane; cluster.push(it); clusterEnd = Math.max(clusterEnd, it.e);
  }
  if (cluster.length) flush();
  return items;
}
function renderWeek() {
  const ws = weekStart();
  const days = [...Array(7)].map((_, i) => addDays(ws, i));
  const tk = todayKey();
  if (S.selDay == null || !days.some((d) => dayKey(d) === S.selDay)) S.selDay = days.some((d) => dayKey(d) === tk) ? tk : dayKey(days[0]);
  const shown = isNarrow() ? days.filter((d) => dayKey(d) === S.selDay) : days;
  const { start: H0, end: H1 } = S.hours;
  const PX = 52;

  // label
  const we = addDays(ws, 6);
  $("weekLabel").textContent = S.weekOffset === 0 ? "This week" : `${ws.toLocaleDateString([], { month: "short", day: "numeric" })} – ${we.toLocaleDateString([], { month: ws.getMonth() === we.getMonth() ? undefined : "short", day: "numeric" })}`;

  // day tabs (narrow)
  const tabs = $("dayTabs"); tabs.replaceChildren(...days.map((d) => el("button", { class: dayKey(d) === S.selDay ? "on" : "", onclick: () => { S.selDay = dayKey(d); renderWeek(); } },
    el("small", { text: d.toLocaleDateString([], { weekday: "short" }) }), String(d.getDate()))));

  // gather items per day
  const per = Object.fromEntries(days.map((d) => [dayKey(d), { timed: [], allday: [], taskMins: 0, meetMins: 0 }]));
  const blockedIds = new Set();
  for (const t of liveTasks()) {
    const w = taskWhen(t); if (!w) continue;
    const k = whenDay(w); if (!per[k]) continue;
    if (w.timed) {
      const s = w.start.getHours() * 60 + w.start.getMinutes();
      per[k].timed.push({ kind: "task", t, s, e: Math.min(s + w.mins, 24 * 60), start: w.start, mins: w.mins, pending: !!S.pending[t.id] });
      per[k].taskMins += w.mins; blockedIds.add(String(t.id));
    } else per[k].allday.push({ kind: "task", t });
  }
  for (const ev of S.events) {
    const mirrorId = ev.extendedProperties?.private?.todoistTaskId;
    if (mirrorId && blockedIds.has(String(mirrorId))) continue;
    const color = ev._cal.backgroundColor || "#4073ff";
    const declined = (ev.attendees || []).some((a) => a.self && a.responseStatus === "declined");
    if (ev.start?.date) {
      let d = parseDay(ev.start.date); const end = parseDay(ev.end?.date || ev.start.date);
      do { const k = dayKey(d); if (per[k]) per[k].allday.push({ kind: "event", ev, color }); d = addDays(d, 1); } while (d < end);
    } else if (ev.start?.dateTime) {
      const s0 = new Date(ev.start.dateTime), e0 = new Date(ev.end?.dateTime || ev.start.dateTime);
      let d = startOfDay(s0);
      while (d < e0) {
        const k = dayKey(d), next = addDays(d, 1);
        if (per[k]) {
          const s = s0 > d ? s0.getHours() * 60 + s0.getMinutes() : 0;
          const e = e0 < next ? e0.getHours() * 60 + e0.getMinutes() : 24 * 60;
          per[k].timed.push({ kind: "event", ev, color, s, e: Math.max(e, s + 15), declined });
          if (!declined && ev.transparency !== "transparent") per[k].meetMins += e - s;
        }
        d = next;
      }
    }
  }

  const week = $("week");
  const prevScroll = week.querySelector(".wk-scroll")?.scrollTop;
  week.style.setProperty("--cols", shown.length);
  const head = el("div", { class: "wk-row wk-head" }, el("div"),
    shown.map((d) => { const k = dayKey(d), p = per[k];
      return el("div", { class: "cell" + (k === tk ? " today" : "") },
        el("div", { class: "dname", text: d.toLocaleDateString([], { weekday: "short" }) }),
        el("div", { class: "dnum", text: d.getDate() }),
        el("div", { class: "load", title: "Meetings · blocked task time", text: `${fmtDur(Math.round(p.meetMins))} · ${fmtDur(p.taskMins)}` })); }));
  const allday = el("div", { class: "wk-row wk-allday" }, el("div", { class: "lbl", text: "all day" }),
    shown.map((d) => { const k = dayKey(d);
      const cell = el("div", { class: "cell", "data-day": k },
        per[k].allday.map((it) => it.kind === "task"
          ? (() => { const c = el("div", { class: "chip task-chip", style: `--c:${projColor(it.t)}`, draggable: "true", text: it.t.content, title: it.t.content, onclick: (e) => openTaskPop(it.t, e.currentTarget) }); wireDrag(c, it.t); return c; })()
          : el("div", { class: "chip", style: `--c:${it.color}`, text: it.ev.summary || "(busy)", title: it.ev.summary || "", onclick: (e) => openEventPop(it.ev, e.currentTarget) })));
      wireDayDrop(cell, k);
      return cell; }));

  const hours = el("div", { class: "hours" }, [...Array(H1 - H0)].map((_, i) => el("div", { text: i === 0 ? "" : fmtHour(H0 + i) })));
  const cols = shown.map((d) => {
    const k = dayKey(d);
    const col = el("div", { class: "col" + (k === tk ? " today" : ""), "data-day": k, style: `height:${(H1 - H0) * PX}px` });
    for (const it of layoutLanes(per[k].timed)) {
      const s = Math.max(it.s, H0 * 60), e = Math.min(it.e, H1 * 60);
      if (e <= s) continue;
      const top = ((s - H0 * 60) / 60) * PX, h = Math.max(((e - s) / 60) * PX - 2, 16);
      const w = 100 / it.lanes;
      const style = `top:${top}px;height:${h}px;left:calc(${it.lane * w}% + 2px);width:calc(${w}% - 4px)`;
      if (it.kind === "task") {
        const b = el("div", { class: "blk task-blk" + (it.pending ? " pending" : ""), style: `${style};--c:${projColor(it.t)}`, draggable: "true", title: it.t.content, onclick: (ev) => openTaskPop(it.t, ev.currentTarget) },
          el("div", { class: "b-title", text: it.t.content }), h > 30 ? el("div", { class: "b-time", text: `${fmtTime(it.start)} · ${fmtDur(it.mins)}` }) : null);
        wireDrag(b, it.t); col.append(b);
      } else {
        const st = new Date(it.ev.start.dateTime);
        col.append(el("div", { class: "blk" + (it.declined ? " declined" : ""), style: `${style};--c:${it.color}`, title: it.ev.summary || "", onclick: (ev) => openEventPop(it.ev, ev.currentTarget) },
          el("div", { class: "b-title", text: it.ev.summary || "(busy)" }), h > 30 ? el("div", { class: "b-time", text: fmtTime(st) }) : null));
      }
    }
    if (k === tk) {
      const now = new Date(), m = now.getHours() * 60 + now.getMinutes();
      if (m >= H0 * 60 && m <= H1 * 60) col.append(el("div", { class: "now", style: `top:${((m - H0 * 60) / 60) * PX}px` }));
    }
    wireSlotDrop(col, k);
    return col;
  });
  const body = el("div", { class: "wk-row wk-body" }, hours, cols);
  const scroll = el("div", { class: "wk-scroll" }, body);
  week.replaceChildren(head, allday, scroll);
  if (prevScroll != null && S.scrolled) scroll.scrollTop = prevScroll;
  else { const target = Math.max(0, (Math.min(new Date().getHours(), 17) - 1 - H0)) * PX; scroll.scrollTop = target; S.scrolled = true; }
}

function render() {
  renderClock(); renderStatus(); renderBanner(); renderSide(); renderWeek();
}

// ---------- drag and drop ----------
let dragTask = null;
function wireDrag(node, t) {
  node.addEventListener("dragstart", (e) => {
    dragTask = t; node.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", String(t.id)); } catch {}
  });
  node.addEventListener("dragend", () => { node.classList.remove("dragging"); dragTask = null; document.querySelectorAll(".ghost").forEach((g) => g.remove()); document.querySelectorAll(".over").forEach((c) => c.classList.remove("over")); });
}
function slotFromEvent(col, e) {
  const PX = 52, r = col.getBoundingClientRect();
  const mins = S.hours.start * 60 + Math.round(((e.clientY - r.top) / PX) * 60 / 15) * 15;
  return Math.max(S.hours.start * 60, Math.min(mins, S.hours.end * 60 - 15));
}
function wireSlotDrop(col, k) {
  col.addEventListener("dragover", (e) => {
    if (!dragTask) return; e.preventDefault();
    const m = slotFromEvent(col, e), dur = taskWhen(dragTask)?.mins || S.durs[dragTask.id] || 60;
    let gh = col.querySelector(".ghost");
    if (!gh) { gh = el("div", { class: "ghost" }); col.append(gh); }
    gh.style.top = ((m - S.hours.start * 60) / 60) * 52 + "px";
    gh.style.height = (dur / 60) * 52 - 2 + "px";
    gh.textContent = fmtTime(new Date(2000, 0, 1, 0, m));
    col.classList.add("over");
  });
  col.addEventListener("dragleave", (e) => { if (!col.contains(e.relatedTarget)) { col.querySelector(".ghost")?.remove(); col.classList.remove("over"); } });
  col.addEventListener("drop", (e) => {
    if (!dragTask) return; e.preventDefault();
    const t = dragTask, m = slotFromEvent(col, e);
    col.querySelector(".ghost")?.remove(); col.classList.remove("over");
    const start = parseDay(k); start.setMinutes(m);
    scheduleTask(t, start, taskWhen(t)?.timed ? taskWhen(t).mins : S.durs[t.id] || 60);
  });
}
function wireDayDrop(cell, k) {
  cell.addEventListener("dragover", (e) => { if (!dragTask) return; e.preventDefault(); cell.classList.add("over"); });
  cell.addEventListener("dragleave", () => cell.classList.remove("over"));
  cell.addEventListener("drop", (e) => { if (!dragTask) return; e.preventDefault(); cell.classList.remove("over"); moveTaskToDay(dragTask, k); });
}

// ---------- popovers ----------
function placePop(anchor) {
  const pop = $("pop"); pop.hidden = false;
  const r = anchor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = r.right + 8; if (left + pw > innerWidth - 16) left = Math.max(16, r.left - pw - 8);
  if (left < 16 || innerWidth < 600) left = Math.max(16, (innerWidth - pw) / 2);
  let top = Math.min(Math.max(16, r.top), innerHeight - ph - 16);
  pop.style.left = left + "px"; pop.style.top = Math.max(16, top) + "px";
}
function fillPop(...kids) { $("pop").replaceChildren(...kids.filter((k) => k != null && k !== false)); }
function closePop() { $("pop").hidden = true; }
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePop(); });
document.addEventListener("pointerdown", (e) => { const p = $("pop"); if (!p.hidden && !p.contains(e.target)) closePop(); });

function timeOptions(sel) {
  const out = [];
  for (let m = S.hours.start * 60; m < S.hours.end * 60; m += 15) out.push(el("option", { value: m, selected: m === sel, text: fmtTime(new Date(2000, 0, 1, 0, m)) }));
  return out;
}
function openTaskPop(t, anchor) {
  const w = taskWhen(t), ws = weekStart(), tk = todayKey();
  const dayOpts = [...new Set([tk, ...[...Array(14)].map((_, i) => dayKey(addDays(ws, i)))])].sort();
  const curDay = w ? whenDay(w) : S.selDay || tk;
  if (!dayOpts.includes(curDay)) dayOpts.unshift(curDay);
  const curMin = w?.timed ? Math.round((w.start.getHours() * 60 + w.start.getMinutes()) / 15) * 15 : Math.max(S.hours.start * 60, Math.min(Math.ceil((new Date().getHours() * 60 + new Date().getMinutes()) / 15) * 15, S.hours.end * 60 - 60));
  const curDur = w?.timed ? w.mins : S.durs[t.id] || 60;
  const durs = [...new Set([15, 30, 45, 60, 90, 120, 180, 240, curDur])].sort((a, b) => a - b);
  const daySel = el("select", { id: "popDay" }, dayOpts.map((d) => el("option", { value: d, selected: d === curDay, text: d === tk ? "Today" : parseDay(d).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) })));
  const timeSel = el("select", { id: "popTime" }, timeOptions(curMin));
  const durSel = el("select", { id: "popDur" }, durs.map((m) => el("option", { value: m, selected: m === curDur, text: fmtDur(m) })));
  const desc = (t.description || "").trim();
  const meta = [projName(t), w ? (w.timed ? `${parseDay(whenDay(w)).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}, ${fmtTime(w.start)}` : parseDay(w.day).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })) : "No date", t.due?.is_recurring ? "repeats " + t.due.string : ""].filter(Boolean).join(" · ");
  fillPop(
    el("h3", { text: t.content }),
    el("div", { class: "meta", text: meta }),
    desc ? el("div", { class: "desc", text: desc }) : null,
    el("div", { class: "grid3" },
      el("label", null, "Day", daySel), el("label", null, "Start", timeSel), el("label", null, "Length", durSel)),
    el("div", { class: "actions" },
      el("button", { class: "btn btn-accent", text: w?.timed ? "Move block" : "Block time", onclick: () => { const s = parseDay(daySel.value); s.setMinutes(+timeSel.value); closePop(); scheduleTask(t, s, +durSel.value); } }),
      el("button", { class: "btn", text: "Complete", onclick: () => { closePop(); completeTask(t); } }),
      w && whenDay(w) !== tk ? el("button", { class: "btn", text: "Move to today", onclick: () => { closePop(); moveTaskToDay(t, tk); } }) : null,
      el("a", { class: "btn btn-ghost", href: `https://app.todoist.com/app/task/${encodeURIComponent(t.id)}`, target: "_blank", rel: "noopener", text: "Open in Todoist" })),
  );
  placePop(anchor);
}
function openEventPop(ev, anchor) {
  const allDay = !!ev.start?.date;
  const when = allDay
    ? parseDay(ev.start.date).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })
    : `${new Date(ev.start.dateTime).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}, ${fmtTime(new Date(ev.start.dateTime))} – ${fmtTime(new Date(ev.end.dateTime))}`;
  const join = safeUrl(ev.hangoutLink) || safeUrl(ev.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri);
  const open = safeUrl(ev.htmlLink);
  fillPop(
    el("h3", { text: ev.summary || "(busy)" }),
    el("div", { class: "meta", text: [when, ev._cal.summaryOverride || ev._cal.summary].filter(Boolean).join(" · ") }),
    ev.location ? el("div", { class: "meta", text: ev.location }) : null,
    el("div", { class: "actions" },
      join ? el("a", { class: "btn btn-accent", href: join, target: "_blank", rel: "noopener", text: "Join call" }) : null,
      open ? el("a", { class: "btn", href: open, target: "_blank", rel: "noopener", text: "Open in Google Calendar" }) : null),
  );
  placePop(anchor);
}

// ---------- setup & settings ----------
function renderSetup() {
  $("todoistOk").hidden = !S.todoistToken;
  $("gNeedsClient").hidden = !!S.gClientId && !!CFG.googleClientId;
  if (S.gClientId && !$("gClientInput").value) $("gClientInput").value = S.gClientId;
  $("gConnectSetup").hidden = !S.gClientId || gReady();
  $("gOk").hidden = !gReady();
}
function openSetup() { renderSetup(); $("setup").hidden = false; }
function closeSetup() { $("setup").hidden = true; LS.set(K.skip, true); render(); }

$("todoistForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = $("todoistInput").value.trim(); if (!v) return;
  S.todoistToken = v; LS.set(K.todoist, v); $("todoistInput").value = "";
  await loadTodoist();
  if (S.err.todoist?.code === "auth") { S.todoistToken = ""; LS.del(K.todoist); toast("Todoist didn't accept that token. Copy it again from Settings → Integrations → Developer."); }
  renderSetup();
});
$("gClientForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("gClientInput").value.trim();
  if (!/\.apps\.googleusercontent\.com$/.test(v)) { toast("That doesn't look like a client ID. It ends in .apps.googleusercontent.com."); return; }
  S.gClientId = v; LS.set(K.gclient, v); S.gtc = null; gInit(); renderSetup();
});
$("gConnectSetup").addEventListener("click", gConnect);
$("skipSetup").addEventListener("click", closeSetup);

function openSettings() {
  const list = $("calList"); list.replaceChildren();
  if (!S.cals.length) list.append(el("p", { class: "hint", text: gReady() ? "No calendars found." : "Connect Google Calendar to choose calendars." }));
  for (const c of S.cals) {
    const id = "cal_" + c.id.replace(/[^a-z0-9]/gi, "_").slice(0, 60);
    const cb = el("input", { type: "checkbox", id, checked: calVisible(c), onchange: () => {
      const hidden = new Set(S.hidden || S.cals.filter(calHiddenByDefault).map((x) => x.id));
      cb.checked ? hidden.delete(c.id) : hidden.add(c.id);
      S.hidden = [...hidden]; LS.set(K.hidden, S.hidden); loadGoogle();
    } });
    list.append(el("label", { class: "check", for: id }, cb, el("i", { class: "dot", style: `background:${c.backgroundColor || "#888"}` }), (c.summaryOverride || c.summary || c.id) + (c.primary ? " (main)" : "")));
  }
  $("mirrorToggle").checked = !!S.mirror;
  const hs = $("hStart"), he = $("hEnd");
  hs.replaceChildren(...[...Array(13)].map((_, h) => el("option", { value: h, selected: h === S.hours.start, text: fmtHour(h) })));
  he.replaceChildren(...[...Array(12)].map((_, i) => { const h = 13 + i; return el("option", { value: h, selected: h === S.hours.end, text: h === 24 ? "Midnight" : fmtHour(h) }); }));
  $("gConnect").textContent = gReady() ? "Reconnect Google" : "Connect Google";
  $("signOutHint").textContent = "Removes your Todoist token, Google sign-in and preferences from this browser. Nothing in Todoist or Google changes.";
  $("signOut").dataset.armed = "";
  $("signOut").textContent = "Forget everything on this device";
  $("settings").showModal();
}
$("mirrorToggle").addEventListener("change", (e) => { S.mirror = e.target.checked; LS.set(K.mirror, S.mirror); });
$("hStart").addEventListener("change", (e) => { S.hours.start = +e.target.value; LS.set(K.hours, S.hours); S.scrolled = false; render(); });
$("hEnd").addEventListener("change", (e) => { S.hours.end = +e.target.value; LS.set(K.hours, S.hours); render(); });
$("gConnect").addEventListener("click", () => { $("settings").close(); gConnect(); });
$("editKeys").addEventListener("click", () => { $("settings").close(); openSetup(); });
$("signOut").addEventListener("click", () => {
  const b = $("signOut");
  if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Tap again to confirm"; return; }
  try { if (S.gToken && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(S.gToken.t, () => {}); } catch {}
  try { Object.keys(localStorage).filter((k) => k.startsWith("tb.")).forEach((k) => localStorage.removeItem(k)); } catch {}
  location.reload();
});

// ---------- wiring ----------
$("prevWeek").addEventListener("click", () => { S.weekOffset--; render(); loadGoogle(); });
$("nextWeek").addEventListener("click", () => { S.weekOffset++; render(); loadGoogle(); });
$("thisWeek").addEventListener("click", () => { S.weekOffset = 0; S.selDay = todayKey(); S.scrolled = false; render(); loadGoogle(); });
$("refreshBtn").addEventListener("click", refreshAll);
$("settingsBtn").addEventListener("click", openSettings);
$("dumpForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const i = $("dumpInput"), v = i.value.trim(); if (!v) return;
  if (!S.todoistToken) { openSetup(); return; }
  i.disabled = true; const ok = await quickAdd(v); i.disabled = false;
  if (ok) i.value = ""; i.focus();
});
// sidebar lists accept drops too (drop on "No date" isn't supported by the API without clearing the date, so we only allow the grid)
let lastNarrow = isNarrow();
window.addEventListener("resize", () => { const n = isNarrow(); if (n !== lastNarrow) { lastNarrow = n; renderWeek(); } });

function refreshAll() { loadTodoist(); loadGoogle(); }
let lastRefresh = Date.now();
document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - lastRefresh > 60000) { lastRefresh = Date.now(); refreshAll(); } });
setInterval(() => { renderClock(); if (!document.hidden && Date.now() - lastRefresh > 5 * 60000) { lastRefresh = Date.now(); refreshAll(); } }, 15000);
setInterval(() => { if (!document.hidden) renderWeek(); }, 60000);

// boot
render();
if (!S.todoistToken && !LS.get(K.skip, false)) openSetup();
loadTodoist();
if (window.google?.accounts?.oauth2) gInit();
loadGoogle();
})();
