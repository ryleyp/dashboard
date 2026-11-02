/* Ryley's Atlas: app logic. Runs as a static site; all keys live in this browser. */
(function () {
  "use strict";

  /* ---------- Constants ---------- */
  const XP_BY_PRIO = { p1: 50, p2: 30, p3: 20, p4: 10 };
  const PRIO_NAME = { p1: "Boss Fight", p2: "Epic Quest", p3: "Quest", p4: "Side Quest" };
  const RANKS = ["Wanderer", "Squire", "Adventurer", "Knight", "Ranger Captain", "Guildmaster", "Archmage", "Dragon Tamer", "Living Legend"];
  const PALETTE = ["#18af7c", "#1f5f8b", "#b48a1e", "#8a3b8f", "#c2562b", "#2a8f8f", "#7a5c2e", "#4b6cb7", "#a33a2a", "#5b8c3a", "#b05c8e", "#3d7a5c", "#8c6d1f", "#2e6f9f", "#6b4e9b", "#9a7b4f", "#2f8f6f", "#c07a2a", "#4a8fb0"];
  const ALMANAC_MATCH = /birthday|^events|partiful|movies|travel|holiday/i;
  const NI_MATCH = /\bNI\b/;
  const GOOGLE_SCOPES = "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/drive.appdata";
  const TODOIST = "https://api.todoist.com/api/v1";
  const DEFAULT_BOOKMARKS = [
    { n: "Salesforce", u: "https://login.salesforce.com" },
    { n: "Slack", u: "https://slack.com" },
    { n: "Gmail", u: "https://mail.google.com" },
    { n: "Calendar", u: "https://calendar.google.com" },
    { n: "Todoist", u: "https://app.todoist.com" },
    { n: "Teams", u: "https://teams.microsoft.com" }
  ];
  const STOCK_OMENS = [
    "The road is long but your boots are sturdy. Take the first engagement with a clear head and the rest will fall into step.\n\nOmen of the day: a raven circles twice, then lands on the gate. Something you have been waiting for arrives early.",
    "The ledger is full, yet the guild has seen fuller. Clear one small quest before noon and the afternoon councils will feel lighter.\n\nOmen of the day: a coin found heads-up on the tavern floor. Luck favors the direct ask.",
    "A quiet board is not an empty one. Use the still hours to sharpen the blade, which is to say, send the follow-up you have been postponing.\n\nOmen of the day: the hearth sparks blue. An old contact brings good news.",
    "Councils cluster like crows on a fence today. Keep your notes short and your water close.\n\nOmen of the day: the compass needle trembles east. Say yes to the unexpected invitation.",
    "The map shows mountains, but every mountain is a series of steps. Begin with the quest you dread most and let momentum carry the rest.\n\nOmen of the day: a cat crosses your path and sits. Patience is rewarded this afternoon."
  ];

  /* ---------- Helpers ---------- */
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  const dkey = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const todayKey = () => dkey(new Date());
  const fmtTime = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const lsGet = (k) => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : null; } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } };

  let toastT = null;
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2600); }
  function sparkleAt(x, y) {
    for (let i = 0; i < 6; i++) {
      const s = document.createElement("div"); s.className = "spark";
      s.style.left = (x - 9 + (Math.random() * 40 - 20)) + "px"; s.style.top = (y - 9 + (Math.random() * 40 - 20)) + "px";
      s.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z"/></svg>';
      document.body.appendChild(s); setTimeout(() => s.remove(), 800);
    }
  }
  function banner(html) { const b = $("banner"); if (!html) { b.hidden = true; b.innerHTML = ""; return; } b.innerHTML = html; b.hidden = false; }

  /* ---------- Keys (per device) and state (synced) ---------- */
  let keys = Object.assign({ gclient: "", tdtoken: "", tdproject: "", akey: "", amodel: "claude-opus-5-5", loc: { lat: 30.27, lon: -97.74, name: "Austin" } }, lsGet("atlas.keys") || {});
  let state = { xp: 0, completions: {}, log: [], bookmarks: DEFAULT_BOOKMARKS.slice(), cals: null, oracle: { date: "", text: "" }, savedAt: 0 };
  function mergeState(s) {
    if (!s || typeof s !== "object") return;
    state = Object.assign({}, state, s);
    if (!Array.isArray(state.bookmarks) || !state.bookmarks.length) state.bookmarks = DEFAULT_BOOKMARKS.slice();
    if (!state.completions) state.completions = {};
    if (!Array.isArray(state.log)) state.log = [];
    if (!state.oracle) state.oracle = { date: "", text: "" };
  }
  mergeState(lsGet("atlas.state"));

  let saveTimer = null;
  function save() {
    state.savedAt = Date.now();
    lsSet("atlas.state", state);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(driveSave, 1200);
  }

  /* ---------- Google auth (token model) ---------- */
  let gToken = lsGet("atlas.gtoken"); // {token, exp}
  let tokenClient = null;
  function gReady() { return !!(window.google && google.accounts && google.accounts.oauth2); }
  function gConnected() { return !!(gToken && gToken.token && gToken.exp > Date.now() + 30000); }
  function makeTokenClient() {
    if (!gReady() || !keys.gclient) return null;
    if (tokenClient) return tokenClient;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: keys.gclient, scope: GOOGLE_SCOPES,
      callback: (resp) => {
        if (resp && resp.access_token) {
          gToken = { token: resp.access_token, exp: Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000 };
          lsSet("atlas.gtoken", gToken); lsSet("atlas.gwas", true);
          renderGStatus(); banner(""); startGoogle();
        } else { renderGStatus(); }
      },
      error_callback: (err) => { renderGStatus(); if (err && err.type !== "popup_closed") toast("Google sign-in did not complete: " + (err.type || "error")); }
    });
    return tokenClient;
  }
  function gConnect(interactive) {
    const tc = makeTokenClient();
    if (!tc) { if (!keys.gclient) toast("Add your Google OAuth Client ID first."); else toast("Google sign-in is still loading. Try again in a moment."); return; }
    tc.requestAccessToken({ prompt: interactive ? "consent" : "" });
  }
  function gDisconnect() {
    if (gToken && gToken.token && gReady()) { try { google.accounts.oauth2.revoke(gToken.token, () => {}); } catch (e) { /* ignore */ } }
    gToken = null; lsSet("atlas.gtoken", null); lsSet("atlas.gwas", false);
    calendars = []; Object.keys(calEvents).forEach((k) => delete calEvents[k]); Object.keys(almEvents).forEach((k) => delete almEvents[k]);
    renderGStatus(); renderLegend(); renderTavern(); renderAlmanac();
  }
  async function gFetch(url, opts) {
    if (!gConnected()) throw Object.assign(new Error("Not connected"), { code: "no_token" });
    const r = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ Authorization: "Bearer " + gToken.token }, (opts && opts.headers) || {}) }));
    if (r.status === 401) { gToken = null; lsSet("atlas.gtoken", null); renderGStatus(); throw Object.assign(new Error("Session expired"), { code: "expired" }); }
    if (!r.ok) { let msg = r.status + " " + r.statusText; try { const j = await r.json(); msg = (j.error && j.error.message) || msg; } catch (e) { /* ignore */ } throw Object.assign(new Error(msg), { code: "http", status: r.status }); }
    if (r.status === 204) return null;
    return r.json();
  }
  function renderGStatus() {
    const s = $("gstatus");
    if (gConnected()) { s.textContent = "Connected"; s.className = "note"; }
    else if (keys.gclient) { s.textContent = "Not connected"; s.className = "warn"; }
    else { s.textContent = "Add a Client ID, then connect"; s.className = "note"; }
  }

  /* ---------- Drive appData sync ---------- */
  let driveFileId = null;
  async function driveLoad() {
    try {
      const list = await gFetch("https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=" + encodeURIComponent("name='atlas-state.json'") + "&fields=files(id,modifiedTime)");
      const f = list && list.files && list.files[0];
      if (!f) return;
      driveFileId = f.id;
      const remote = await gFetch("https://www.googleapis.com/drive/v3/files/" + f.id + "?alt=media");
      if (remote && typeof remote === "object" && (remote.savedAt || 0) > (state.savedAt || 0)) {
        mergeState(remote); lsSet("atlas.state", state);
        renderHeader(); renderPortals(); renderDeeds(); renderOracleStored(); renderLegend(); syncCalendars();
        $("deedsMsg").textContent = "Progress synced from your other devices.";
      } else if (remote && (remote.savedAt || 0) < (state.savedAt || 0)) {
        driveSave();
      }
    } catch (e) { if (e.code !== "no_token") $("deedsMsg").textContent = "Could not sync progress through Google Drive. It is kept on this device."; }
  }
  async function driveSave() {
    if (!gConnected()) return;
    try {
      const body = JSON.stringify(state);
      if (driveFileId) {
        await gFetch("https://www.googleapis.com/upload/drive/v3/files/" + driveFileId + "?uploadType=media", { method: "PATCH", headers: { "Content-Type": "application/json" }, body });
      } else {
        const boundary = "atlas" + Date.now();
        const multi = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify({ name: "atlas-state.json", parents: ["appDataFolder"] }) + "\r\n--" + boundary + "\r\nContent-Type: application/json\r\n\r\n" + body + "\r\n--" + boundary + "--";
        const r = await gFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body: multi });
        driveFileId = r && r.id;
      }
    } catch (e) { /* kept locally */ }
  }

  /* ---------- Header ---------- */
  function levelFor(xp) { let l = 0; while (xp >= 100 * (l + 1) * (l + 2) / 2) l++; return l; }
  function renderHeader() {
    const h = new Date().getHours();
    const g = h < 5 ? "Burning the Midnight Oil" : h < 12 ? "Good Morrow" : h < 17 ? "Good Day" : h < 21 ? "Good Evening" : "The Stars Are Out";
    $("greet").textContent = g + ", Guildmaster";
    $("dateline").textContent = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" }) + ". The map unrolls.";
    const lvl = levelFor(state.xp), base = 100 * lvl * (lvl + 1) / 2, next = 100 * (lvl + 1) * (lvl + 2) / 2;
    $("lvlnum").textContent = lvl + 1;
    $("rank").textContent = "Level " + (lvl + 1) + " " + RANKS[Math.min(lvl, RANKS.length - 1)];
    $("xpline").textContent = state.xp + " XP, " + (next - state.xp) + " to next rank";
    $("xpfill").style.width = Math.round(100 * (state.xp - base) / (next - base)) + "%";
  }

  /* ---------- Calendars ---------- */
  let calendars = []; const calColor = {}; const calEvents = {}; const almEvents = {};
  let calTimer = null;
  function calEnabled(id) { return !state.cals || state.cals[id] !== false; }
  function windowFor(days) { const s = new Date(); s.setHours(0, 0, 0, 0); const e = new Date(s); e.setDate(e.getDate() + days); return { timeMin: s.toISOString(), timeMax: e.toISOString() }; }
  function parseStart(ev) { const st = ev.start || {}; if (st.dateTime) return { d: new Date(st.dateTime), allDay: false }; const [y, m, dd] = (st.date || "").slice(0, 10).split("-").map(Number); return { d: new Date(y, m - 1, dd), allDay: true }; }
  function parseEnd(ev) { const en = ev.end || {}; if (en.dateTime) return new Date(en.dateTime); const [y, m, dd] = (en.date || "").slice(0, 10).split("-").map(Number); return new Date(y, m - 1, dd); }

  async function startGoogle() {
    if (!gConnected()) return;
    try {
      const r = await gFetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250&fields=items(id,summary,backgroundColor)");
      calendars = (r.items || []).map((c) => ({ id: c.id, name: (c.summary || c.id).trim() || "Unnamed", color: c.backgroundColor }));
      calendars.sort((a, b) => a.name.localeCompare(b.name));
      calendars.forEach((c, i) => calColor[c.id] = c.color || PALETTE[i % PALETTE.length]);
      renderLegend(); syncCalendars();
      driveLoad();
    } catch (e) {
      const msg = e.code === "expired" ? "Your Google session expired. Reconnect in the Keeper's Keys." : "Could not reach Google Calendar: " + e.message;
      $("days").innerHTML = '<span class="warn">' + esc(msg) + "</span>";
    }
  }
  function renderLegend() {
    const g = $("calgrid"); g.innerHTML = "";
    if (!calendars.length) { g.innerHTML = '<span class="note">' + (gConnected() ? "No calendars found." : "Connect Google in the Keeper's Keys to see your calendars.") + "</span>"; return; }
    calendars.forEach((c) => {
      const l = document.createElement("label");
      l.innerHTML = '<input type="checkbox"><span class="swatch" style="background:' + esc(calColor[c.id]) + '"></span><span class="name" title="' + esc(c.name) + '">' + esc(c.name) + "</span>";
      const cb = l.querySelector("input"); cb.checked = calEnabled(c.id);
      cb.addEventListener("change", () => { state.cals = state.cals || {}; state.cals[c.id] = cb.checked; save(); syncCalendars(); });
      g.appendChild(l);
    });
  }
  $("calAll").addEventListener("click", () => { state.cals = {}; save(); renderLegend(); syncCalendars(); });
  $("calNone").addEventListener("click", () => { state.cals = {}; calendars.forEach((c) => state.cals[c.id] = false); save(); renderLegend(); syncCalendars(); });

  async function syncCalendars() {
    if (!gConnected() || !calendars.length) { renderTavern(); renderAlmanac(); return; }
    const w7 = windowFor(7), w60 = windowFor(60);
    const errs = [];
    await Promise.all(calendars.map(async (c) => {
      const isAlm = ALMANAC_MATCH.test(c.name) && !NI_MATCH.test(c.name);
      if (!calEnabled(c.id)) delete calEvents[c.id];
      if (!calEnabled(c.id) && !isAlm) return;
      try {
        const base = "https://www.googleapis.com/calendar/v3/calendars/" + encodeURIComponent(c.id) + "/events?singleEvents=true&orderBy=startTime&fields=items(id,summary,start,end,location,htmlLink,status)";
        if (calEnabled(c.id)) {
          const r = await gFetch(base + "&maxResults=60&timeMin=" + encodeURIComponent(w7.timeMin) + "&timeMax=" + encodeURIComponent(w7.timeMax));
          calEvents[c.id] = (r.items || []).filter((e) => e.status !== "cancelled");
        }
        if (isAlm) {
          const r = await gFetch(base + "&maxResults=40&timeMin=" + encodeURIComponent(w60.timeMin) + "&timeMax=" + encodeURIComponent(w60.timeMax));
          almEvents[c.id] = (r.items || []).filter((e) => e.status !== "cancelled");
        }
      } catch (e) { errs.push(c.name + ": " + e.message); }
    }));
    renderTavern(); renderAlmanac();
    $("tavernMsg").innerHTML = errs.length ? '<p class="warn" style="margin:10px 0 0">' + esc(errs[0]) + (errs.length > 1 ? " (+" + (errs.length - 1) + " more)" : "") + "</p>" : "";
    clearTimeout(calTimer); calTimer = setTimeout(syncCalendars, 10 * 60 * 1000);
  }

  function renderTavern() {
    const all = [];
    calendars.forEach((c) => { if (!calEnabled(c.id)) return; (calEvents[c.id] || []).forEach((e) => { const s = parseStart(e); if (isNaN(s.d)) return; all.push({ e, cal: c, start: s.d, allDay: s.allDay, end: parseEnd(e) }); }); });
    all.sort((a, b) => a.start - b.start || (a.allDay ? -1 : 1));
    const now = new Date();
    const next = all.find((x) => !x.allDay && x.start > now);
    const nu = $("nextup");
    if (next) { const mins = Math.round((next.start - now) / 60000); const inTxt = mins < 60 ? mins + " min" : mins < 1440 ? Math.floor(mins / 60) + "h " + (mins % 60) + "m" : Math.round(mins / 1440) + " days"; nu.innerHTML = '<div class="nextup"><span class="hg">Next</span><span class="what">' + esc(next.e.summary || "(untitled)") + '</span><span class="in">in ' + esc(inTxt) + "</span></div>"; }
    else nu.innerHTML = "";
    const days = $("days"); days.innerHTML = "";
    if (!gConnected()) { days.innerHTML = '<span class="note">Connect Google in the Keeper\'s Keys to fill the board.</span>'; return; }
    if (!all.length) { days.innerHTML = '<span class="note">' + (calendars.some((c) => calEnabled(c.id)) ? "A quiet week. No engagements on the chosen calendars." : "No calendars chosen. Open the Map Legend above to pick some.") + "</span>"; return; }
    const byDay = {}; all.forEach((x) => { const k = dkey(x.start); (byDay[k] = byDay[k] || []).push(x); });
    const base = new Date(); base.setHours(0, 0, 0, 0);
    for (let i = 0; i < 7; i++) {
      const d = new Date(base); d.setDate(d.getDate() + i); const list = byDay[dkey(d)]; if (!list) continue;
      const row = document.createElement("div"); row.className = "day";
      const lab = i === 0 ? "Today" : i === 1 ? "Tomorrow" : d.toLocaleDateString([], { weekday: "short" });
      row.innerHTML = '<div class="dlabel"><b>' + esc(lab) + "</b>" + d.toLocaleDateString([], { month: "short", day: "numeric" }) + '</div><div class="evs"></div>';
      const evs = row.querySelector(".evs");
      list.forEach((x) => {
        const div = document.createElement("div"); div.className = "ev" + (x.end < now ? " past" : "");
        const t = x.allDay ? "All day" : fmtTime(x.start);
        const link = x.e.htmlLink ? '<a href="' + esc(x.e.htmlLink) + '" target="_blank" rel="noopener">' + esc(x.e.summary || "(untitled)") + "</a>" : esc(x.e.summary || "(untitled)");
        const loc = x.e.location && !/^http/.test(x.e.location) ? "<small>" + esc(x.e.location) + "</small>" : "";
        div.innerHTML = '<span class="bar" style="background:' + esc(calColor[x.cal.id]) + '"></span><span class="t">' + esc(t) + '</span><span class="n">' + link + "<small>" + esc(x.cal.name) + "</small>" + loc + "</span>";
        evs.appendChild(div);
      });
      days.appendChild(row);
    }
  }

  function renderAlmanac() {
    const el = $("alm");
    if (!gConnected()) { el.innerHTML = '<span class="note">Connect Google to turn the pages.</span>'; return; }
    const rows = []; const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    calendars.forEach((c) => { (almEvents[c.id] || []).forEach((e) => { const s = parseStart(e); if (isNaN(s.d)) return; rows.push({ e, cal: c, start: s.d }); }); });
    rows.sort((a, b) => a.start - b.start);
    el.innerHTML = "";
    if (!rows.length) { el.innerHTML = '<span class="note">No feast days or festivities in the next sixty days.</span>'; return; }
    rows.slice(0, 12).forEach((r) => {
      const days = Math.round((new Date(r.start.getFullYear(), r.start.getMonth(), r.start.getDate()) - t0) / 86400000);
      const kind = /birthday/i.test(r.cal.name) ? "Feast Day" : r.cal.name.replace(/\s*\/.*$/, "");
      const inTxt = days === 0 ? "today" : days === 1 ? "tomorrow" : "in " + days + " days";
      const div = document.createElement("div"); div.className = "arow";
      div.innerHTML = '<span class="date">' + esc(r.start.toLocaleDateString([], { month: "short" })) + "<b>" + r.start.getDate() + '</b></span><span class="what" title="' + esc(r.e.summary || "") + '">' + esc(r.e.summary || "(untitled)") + "<small>" + esc(kind) + '</small></span><span class="in">' + esc(inTxt) + "</span>";
      el.appendChild(div);
    });
  }

  /* ---------- Todoist ---------- */
  let tasks = [], sections = {}, questTimer = null;
  async function td(path, opts) {
    if (!keys.tdtoken) throw Object.assign(new Error("No Todoist token"), { code: "no_token" });
    const r = await fetch(TODOIST + path, Object.assign({}, opts, { headers: Object.assign({ Authorization: "Bearer " + keys.tdtoken }, (opts && opts.headers) || {}) }));
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error("Todoist rejected the token. Check it in the Keeper's Keys."), { code: "auth" });
    if (!r.ok) throw Object.assign(new Error("Todoist answered " + r.status), { code: "http" });
    if (r.status === 204) return null;
    const text = await r.text(); return text ? JSON.parse(text) : null;
  }
  const listOf = (j) => Array.isArray(j) ? j : (j && (j.results || j.items)) || [];
  async function loadProjects() {
    const sel = $("tdproject");
    try {
      const j = await td("/projects?limit=200"); const list = listOf(j);
      sel.innerHTML = list.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.name) + "</option>").join("");
      if (keys.tdproject && list.some((p) => String(p.id) === String(keys.tdproject))) sel.value = keys.tdproject;
      else { const w = list.find((p) => /work/i.test(p.name)) || list[0]; if (w) { sel.value = w.id; keys.tdproject = String(w.id); lsSet("atlas.keys", keys); } }
      const chosen = list.find((p) => String(p.id) === String(sel.value)); $("questSub").textContent = chosen ? chosen.name + ", from Todoist" : "From Todoist";
    } catch (e) { sel.innerHTML = '<option value="">' + esc(e.message) + "</option>"; }
  }
  async function loadQuests() {
    clearTimeout(questTimer);
    if (!keys.tdtoken) { $("qbody").innerHTML = '<span class="note">Add your Todoist token in the Keeper\'s Keys to unfurl the scroll.</span>'; return; }
    if (!keys.tdproject) { await loadProjects(); if (!keys.tdproject) { $("qbody").innerHTML = '<span class="note">Choose a project in the Keeper\'s Keys.</span>'; return; } }
    try {
      const [sj, tj] = await Promise.all([td("/sections?project_id=" + encodeURIComponent(keys.tdproject) + "&limit=200"), td("/tasks?project_id=" + encodeURIComponent(keys.tdproject) + "&limit=200")]);
      sections = {}; listOf(sj).forEach((s) => sections[s.id] = { name: s.name, order: s.section_order ?? s.order ?? 0 });
      let list = listOf(tj); let cursor = tj && tj.next_cursor; let guard = 0;
      while (cursor && guard++ < 3) { const more = await td("/tasks?project_id=" + encodeURIComponent(keys.tdproject) + "&limit=200&cursor=" + encodeURIComponent(cursor)); list = list.concat(listOf(more)); cursor = more && more.next_cursor; }
      tasks = list.filter((t) => !t.checked && !t.is_completed).map(normalizeTask);
      $("questMsg").innerHTML = ""; renderQuests();
    } catch (e) { $("questMsg").innerHTML = '<p class="warn" style="margin:8px 0 0">' + esc(e.message) + "</p>"; if (!tasks.length) $("qbody").innerHTML = ""; }
    questTimer = setTimeout(loadQuests, 5 * 60 * 1000);
  }
  function normalizeTask(t) {
    const p = Number(t.priority) || 1; // Todoist API: 4 is the most urgent
    const due = t.due || {};
    return { id: String(t.id), content: t.content || "", priority: "p" + (5 - p), dueDate: due.datetime || due.date || "", recurring: !!due.is_recurring, sectionId: t.section_id ? String(t.section_id) : "", labels: t.labels || [] };
  }
  function dueInfo(t) {
    if (!t.dueDate) return { txt: "", over: false, today: false, ts: Infinity };
    const [y, m, d] = t.dueDate.slice(0, 10).split("-").map(Number); const due = new Date(y, m - 1, d);
    const t0 = new Date(); t0.setHours(0, 0, 0, 0); const diff = Math.round((due - t0) / 86400000);
    let txt = diff === 0 ? "Due today" : diff === 1 ? "Due tomorrow" : diff < 0 ? "Overdue by " + (-diff) + (diff === -1 ? " day" : " days") : "Due " + due.toLocaleDateString([], { month: "short", day: "numeric" });
    if (/T\d/.test(t.dueDate)) { const dt = new Date(t.dueDate); if (!isNaN(dt)) txt += " at " + fmtTime(dt); }
    if (t.recurring) txt += " (repeats)";
    return { txt, over: diff < 0, today: diff === 0, ts: due.getTime() };
  }
  function renderQuests() {
    const body = $("qbody"); body.innerHTML = "";
    if (!tasks.length) { body.innerHTML = '<span class="note">The quest board is clear. Rest, adventurer.</span>'; return; }
    const urgent = tasks.filter((t) => { const d = dueInfo(t); return d.over || d.today; });
    const groups = []; if (urgent.length) groups.push({ name: "Urgent Quests", list: urgent });
    const bySec = {}; tasks.filter((t) => !urgent.includes(t)).forEach((t) => { const k = t.sectionId || "_"; (bySec[k] = bySec[k] || []).push(t); });
    Object.keys(bySec).sort((a, b) => ((sections[a] || {}).order ?? 99) - ((sections[b] || {}).order ?? 99)).forEach((k) => groups.push({ name: (sections[k] || {}).name || "Unsorted Quests", list: bySec[k] }));
    const prioRank = { p1: 0, p2: 1, p3: 2, p4: 3 };
    groups.forEach((g) => {
      g.list.sort((a, b) => prioRank[a.priority] - prioRank[b.priority] || dueInfo(a).ts - dueInfo(b).ts);
      const wrap = document.createElement("div"); wrap.className = "qgroup";
      wrap.innerHTML = "<h3>" + esc(g.name) + '<span class="cnt">' + g.list.length + '</span></h3><div class="qlist"></div>';
      const ql = wrap.querySelector(".qlist");
      g.list.forEach((t) => {
        const d = dueInfo(t); const div = document.createElement("div"); div.className = "q";
        const labels = t.labels.map((l) => '<span class="lab">#' + esc(l) + "</span>").join("");
        div.innerHTML = '<button class="chk" type="button" aria-label="Complete quest"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M4 12l5 5L20 7"/></svg></button><span class="c">' + esc(t.content) + '<small class="' + (d.over ? "over" : "") + '">' + labels + esc(d.txt) + '</small></span><span class="pill ' + esc(t.priority) + '">' + esc(PRIO_NAME[t.priority] || "Quest") + "</span>";
        div.querySelector(".chk").addEventListener("click", (ev) => completeQuest(t, div, ev));
        ql.appendChild(div);
      });
      body.appendChild(wrap);
    });
  }
  async function completeQuest(t, div, ev) {
    if (div.classList.contains("done")) return;
    div.classList.add("done"); const btn = div.querySelector(".chk"); btn.disabled = true;
    try {
      await td("/tasks/" + encodeURIComponent(t.id) + "/close", { method: "POST" });
      const gain = XP_BY_PRIO[t.priority] || 10; const k = todayKey(); const before = levelFor(state.xp);
      state.xp += gain; state.completions[k] = (state.completions[k] || 0) + 1;
      state.log.unshift({ t: Date.now(), w: t.content, xp: gain }); state.log = state.log.slice(0, 40);
      save(); renderHeader(); renderDeeds();
      sparkleAt(ev.clientX || window.innerWidth / 2, ev.clientY || window.innerHeight / 2);
      toast(levelFor(state.xp) > before ? "Rank up! You are now a " + RANKS[Math.min(levelFor(state.xp), RANKS.length - 1)] : "+" + gain + " XP. Quest complete.");
      tasks = tasks.filter((x) => x.id !== t.id); setTimeout(renderQuests, 500);
    } catch (e) { div.classList.remove("done"); btn.disabled = false; toast("Could not complete it in Todoist."); $("questMsg").innerHTML = '<p class="warn" style="margin:8px 0 0">' + esc(e.message) + "</p>"; }
  }

  /* ---------- Oracle ---------- */
  function streakCount() { let n = 0; const d = new Date(); d.setHours(0, 0, 0, 0); if (!state.completions[dkey(d)]) { d.setDate(d.getDate() - 1); if (!state.completions[dkey(d)]) return 0; } while (state.completions[dkey(d)]) { n++; d.setDate(d.getDate() - 1); } return n; }
  function buildOraclePrompt() {
    const evs = []; calendars.forEach((c) => { if (!calEnabled(c.id)) return; (calEvents[c.id] || []).forEach((e) => { const s = parseStart(e); if (dkey(s.d) === todayKey()) evs.push((s.allDay ? "all day" : fmtTime(s.d)) + ": " + (e.summary || "untitled") + " (" + c.name + ")"); }); });
    const qs = tasks.slice().sort((a, b) => dueInfo(a).ts - dueInfo(b).ts).slice(0, 8).map((t) => t.content + (dueInfo(t).txt ? " [" + dueInfo(t).txt + "]" : ""));
    const wx = lastWeather ? ("Weather: " + lastWeather.desc + ", " + lastWeather.temp + " degrees.") : "";
    return "You are the Oracle of an adventure-map dashboard belonging to a customer success manager who works in software sales. Write her a short daily reading in the voice of a warm, slightly dramatic fantasy bard. Be encouraging and specific to the items below. Refer to meetings as engagements or councils and tasks as quests. Keep it under 130 words, in two short paragraphs, plain prose, no headings, no bullet points, no emoji, and never use an em dash. End with one playful omen for the day.\n\nToday's engagements:\n" + (evs.length ? evs.join("\n") : "none on the board") + "\n\nOpen quests:\n" + (qs.length ? qs.join("\n") : "none") + "\n\n" + wx + "\nCurrent rank: " + $("rank").textContent + ". Day streak: " + streakCount() + ".";
  }
  function renderOracleStored() { if (state.oracle.date === todayKey() && state.oracle.text) { $("reading").textContent = state.oracle.text; $("askOracle").textContent = "Seek a New Reading"; } }
  async function consultOracle() {
    const btn = $("askOracle"); btn.disabled = true; $("oracleMsg").textContent = "The Oracle gazes into the mist...";
    try {
      let text;
      if (keys.akey) {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": keys.akey, "anthropic-version": "2026-10-21", "anthropic-beta": "server-side-fallback-2026-07-01", "anthropic-dangerous-direct-browser-access": "true" },
          body: JSON.stringify({ model: keys.amodel || "claude-opus-5-5", max_tokens: 1024, fallbacks: "default", output_config: { effort: "low" }, messages: [{ role: "user", content: buildOraclePrompt() }] })
        });
        const j = await r.json();
        if (!r.ok) throw new Error((j.error && j.error.message) || ("The Oracle's line answered " + r.status));
        if (j.stop_reason === "refusal") throw new Error("The Oracle declined to speak on this.");
        text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      } else {
        const seed = Number(todayKey().replace(/-/g, "")) + (state.oracle.text ? 1 : 0);
        text = STOCK_OMENS[seed % STOCK_OMENS.length];
      }
      state.oracle = { date: todayKey(), text }; $("reading").textContent = text; save(); $("oracleMsg").textContent = keys.akey ? "" : "A stock omen. Add an Anthropic key in the Keeper's Keys for a live reading."; btn.textContent = "Seek a New Reading";
    } catch (e) { $("oracleMsg").textContent = "The mist would not clear. " + e.message; }
    btn.disabled = false;
  }
  $("askOracle").addEventListener("click", consultOracle);

  /* ---------- Scrying pool: weather, moon, sun ---------- */
  let lastWeather = null, wxTimer = null;
  const WX_CODES = { 0: ["Clear skies", "☀️"], 1: ["Mostly clear", "🌤️"], 2: ["Partly cloudy", "⛅"], 3: ["Overcast", "☁️"], 45: ["Fog over the realm", "🌫️"], 48: ["Rime fog", "🌫️"], 51: ["Light drizzle", "🌦️"], 53: ["Drizzle", "🌦️"], 55: ["Heavy drizzle", "🌧️"], 61: ["Light rain", "🌧️"], 63: ["Rain", "🌧️"], 65: ["Heavy rain", "🌧️"], 66: ["Freezing rain", "🌨️"], 67: ["Freezing rain", "🌨️"], 71: ["Light snow", "🌨️"], 73: ["Snow", "❄️"], 75: ["Heavy snow", "❄️"], 77: ["Snow grains", "🌨️"], 80: ["Rain showers", "🌦️"], 81: ["Rain showers", "🌧️"], 82: ["Violent showers", "⛈️"], 85: ["Snow showers", "🌨️"], 86: ["Snow showers", "❄️"], 95: ["Thunderstorm", "⛈️"], 96: ["Thunderstorm with hail", "⛈️"], 99: ["Thunderstorm with hail", "⛈️"] };
  const FLAVOR = { 0: "The sky is a clean blue shield.", 1: "A fine day for the road.", 2: "Clouds wander like sheep.", 3: "A grey cloak lies over the land.", 45: "Keep to the path; the mist hides the markers.", 48: "Keep to the path; the mist hides the markers.", 51: "A soft drizzle. Bring a hood.", 53: "A soft drizzle. Bring a hood.", 55: "Steady drizzle. The roads will be muddy.", 61: "Rain on the roof, good for reading.", 63: "The rain means it today. Cloak up.", 65: "The heavens are emptying. Stay by the hearth if you can.", 71: "A dusting of snow on the battlements.", 73: "Snow falls. The realm goes quiet.", 75: "A proper blizzard. Guard the gates.", 80: "Showers come and go. Expect both.", 81: "Showers come and go. Expect both.", 82: "Violent showers. Postpone the expedition.", 95: "Thunder over the hills. The dragons are restless.", 96: "Thunder and hail. Stay indoors.", 99: "Thunder and hail. Stay indoors." };
  async function loadWeather() {
    clearTimeout(wxTimer);
    const { lat, lon, name } = keys.loc;
    $("poolSub").textContent = "Skies over " + (name || "the realm");
    try {
      const u = "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon + "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=4";
      const r = await fetch(u); if (!r.ok) throw new Error("The pool answered " + r.status);
      const j = await r.json(); const c = j.current || {};
      const code = Number(c.weather_code); const [desc, icon] = WX_CODES[code] || ["Changeable", "🌤️"];
      lastWeather = { desc, temp: Math.round(c.temperature_2m) };
      $("wx").innerHTML = '<div class="temp">' + Math.round(c.temperature_2m) + "°</div><div class=\"desc\">" + icon + " " + esc(desc) + ". " + esc(FLAVOR[code] || "") + "<small>Feels like " + Math.round(c.apparent_temperature) + "°, wind " + Math.round(c.wind_speed_10m) + " mph</small></div>";
      const d = j.daily || {}; const f = $("forecast"); f.innerHTML = "";
      (d.time || []).slice(0, 4).forEach((day, i) => {
        const [y, m, dd] = day.split("-").map(Number); const dt = new Date(y, m - 1, dd);
        const cc = WX_CODES[Number(d.weather_code[i])] || ["", "🌤️"];
        const el = document.createElement("div"); el.className = "fd";
        el.innerHTML = "<b>" + (i === 0 ? "Today" : dt.toLocaleDateString([], { weekday: "short" })) + "</b><i>" + cc[1] + "</i><span>" + Math.round(d.temperature_2m_max[i]) + "° / " + Math.round(d.temperature_2m_min[i]) + "°</span><span>" + (d.precipitation_probability_max[i] ?? 0) + "% rain</span>";
        f.appendChild(el);
      });
    } catch (e) { $("wx").innerHTML = '<span class="warn">The pool is clouded. ' + esc(e.message) + "</span>"; }
    wxTimer = setTimeout(loadWeather, 30 * 60 * 1000);
  }
  function moonPhase(d) { const synodic = 29.530588853; const ref = Date.UTC(2000, 0, 6, 18, 14); let p = ((d.getTime() - ref) / 86400000 % synodic) / synodic; if (p < 0) p += 1; return p; }
  function moonName(p) { if (p < .03 || p > .97) return "New Moon"; if (p < .22) return "Waxing Crescent"; if (p < .28) return "First Quarter"; if (p < .47) return "Waxing Gibbous"; if (p < .53) return "Full Moon"; if (p < .72) return "Waning Gibbous"; if (p < .78) return "Last Quarter"; return "Waning Crescent"; }
  function sunTimes(date, lat, lon) {
    const rad = Math.PI / 180, J1970 = 2440588, J2000 = 2451545;
    const toJ = (d) => d.valueOf() / 86400000 - 0.5 + J1970, fromJ = (j) => new Date((j + 0.5 - J1970) * 86400000);
    const d = toJ(date) - J2000, lw = rad * -lon, phi = rad * lat;
    const n = Math.round(d - 0.0009 - lw / (2 * Math.PI)), ds = 0.0009 + lw / (2 * Math.PI) + n;
    const M = rad * (357.5291 + 0.98560028 * ds), C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)), P = rad * 102.9372;
    const L = M + C + P + Math.PI, dec = Math.asin(Math.sin(L) * Math.sin(rad * 23.4397));
    const Jnoon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    const cosw = (Math.sin(rad * -0.833) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
    if (cosw > 1 || cosw < -1) return null;
    const w = Math.acos(cosw), Jset = J2000 + (ds + w / (2 * Math.PI)) + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    return { rise: fromJ(Jnoon - (Jset - Jnoon)), set: fromJ(Jset) };
  }
  function renderSky() {
    const now = new Date(); const p = moonPhase(now); $("moonName").textContent = moonName(p);
    const illum = p <= .5 ? p * 2 : (1 - p) * 2; const x = (1 - illum) * 100; $("moonShade").style.transform = "translateX(" + (p <= .5 ? x : -x) + "%)";
    const st = sunTimes(now, Number(keys.loc.lat), Number(keys.loc.lon));
    if (st) { $("sunrise").textContent = fmtTime(st.rise); $("sunset").textContent = fmtTime(st.set); const mins = Math.round((st.set - st.rise) / 60000); $("daylen").textContent = Math.floor(mins / 60) + "h " + (mins % 60) + "m"; }
    else { $("sunrise").textContent = "None"; $("sunset").textContent = "None"; $("daylen").textContent = "Polar skies"; }
  }

  /* ---------- Portals ---------- */
  function renderPortals() {
    const g = $("portalgrid"); g.innerHTML = "";
    state.bookmarks.forEach((b, i) => {
      const a = document.createElement("a"); a.className = "portal"; a.href = b.u; a.target = "_blank"; a.rel = "noopener"; a.title = b.u;
      a.innerHTML = '<span class="seal">' + esc((b.n || "?").trim().charAt(0).toUpperCase()) + '</span><span class="nm">' + esc(b.n) + '</span><button class="rm" type="button" aria-label="Close this portal">&times;</button>';
      a.querySelector(".rm").addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); state.bookmarks.splice(i, 1); save(); renderPortals(); });
      g.appendChild(a);
    });
  }
  $("addportal").addEventListener("submit", (ev) => { ev.preventDefault(); const n = $("pname").value.trim(), u = $("purl").value.trim(); if (!n || !u) return; state.bookmarks.push({ n, u }); $("pname").value = ""; $("purl").value = ""; save(); renderPortals(); toast("A new portal opens."); });

  /* ---------- Deeds ---------- */
  function renderDeeds() {
    $("sStreak").textContent = streakCount(); $("sToday").textContent = state.completions[todayKey()] || 0;
    $("sTotal").textContent = Object.values(state.completions).reduce((a, b) => a + b, 0);
    const w = $("week"); w.innerHTML = ""; const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 13);
    for (let i = 0; i < 14; i++) { const k = dkey(d); const c = state.completions[k] || 0; const i2 = document.createElement("i"); i2.className = (c ? "on" : "") + (k === todayKey() ? " today" : ""); i2.title = d.toLocaleDateString([], { month: "short", day: "numeric" }) + ": " + c + " quest" + (c === 1 ? "" : "s"); w.appendChild(i2); d.setDate(d.getDate() + 1); }
    const log = $("deedlog"); log.innerHTML = "";
    if (!state.log.length) { log.innerHTML = '<li class="note">No deeds recorded yet. Complete a quest to begin the chronicle.</li>'; return; }
    state.log.slice(0, 8).forEach((e) => { const li = document.createElement("li"); li.innerHTML = "<span>" + esc(new Date(e.t).toLocaleDateString([], { month: "short", day: "numeric" })) + '</span><span class="what">' + esc(e.w) + "</span><b>+" + e.xp + " XP</b>"; log.appendChild(li); });
  }

  /* ---------- Keeper's Keys (settings) ---------- */
  function openKeys() {
    $("gclient").value = keys.gclient || ""; $("tdtoken").value = keys.tdtoken || ""; $("akey").value = keys.akey || ""; $("amodel").value = keys.amodel || "claude-opus-5-5";
    $("city").value = keys.loc.name || ""; $("cityResult").textContent = keys.loc.name ? "Current: " + keys.loc.name + " (" + keys.loc.lat + ", " + keys.loc.lon + ")" : "";
    renderGStatus(); if (keys.tdtoken) loadProjects();
    $("keys").hidden = false; $("gclient").focus();
  }
  function closeKeys() { $("keys").hidden = true; }
  $("openKeys").addEventListener("click", openKeys);
  $("closeKeys").addEventListener("click", closeKeys);
  $("keys").addEventListener("click", (ev) => { if (ev.target === $("keys")) closeKeys(); });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && !$("keys").hidden) closeKeys(); });
  $("tdtoken").addEventListener("change", () => { keys.tdtoken = $("tdtoken").value.trim(); lsSet("atlas.keys", keys); if (keys.tdtoken) loadProjects(); });
  $("gclient").addEventListener("change", () => { const v = $("gclient").value.trim(); if (v !== keys.gclient) { keys.gclient = v; tokenClient = null; lsSet("atlas.keys", keys); renderGStatus(); } });
  $("gconnect").addEventListener("click", () => { keys.gclient = $("gclient").value.trim(); lsSet("atlas.keys", keys); tokenClient = null; gConnect(true); });
  $("gdisconnect").addEventListener("click", gDisconnect);
  $("findCity").addEventListener("click", async () => {
    const q = $("city").value.trim(); if (!q) return; $("cityResult").textContent = "Searching the maps...";
    try {
      const r = await fetch("https://geocoding-api.open-meteo.com/v1/search?name=" + encodeURIComponent(q) + "&count=1&language=en&format=json");
      const j = await r.json(); const hit = j.results && j.results[0];
      if (!hit) { $("cityResult").textContent = "No such place on the map. Try a larger town nearby."; return; }
      keys.loc = { lat: Math.round(hit.latitude * 100) / 100, lon: Math.round(hit.longitude * 100) / 100, name: hit.name + (hit.admin1 ? ", " + hit.admin1 : "") };
      lsSet("atlas.keys", keys); $("cityResult").textContent = "Found: " + keys.loc.name + " (" + keys.loc.lat + ", " + keys.loc.lon + ")";
      loadWeather(); renderSky();
    } catch (e) { $("cityResult").textContent = "The maps are unreadable right now."; }
  });
  $("saveKeys").addEventListener("click", () => {
    keys.gclient = $("gclient").value.trim(); keys.tdtoken = $("tdtoken").value.trim(); keys.akey = $("akey").value.trim(); keys.amodel = $("amodel").value.trim() || "claude-opus-5-5";
    const sel = $("tdproject"); if (sel.value) { keys.tdproject = sel.value; const o = sel.options[sel.selectedIndex]; $("questSub").textContent = (o ? o.textContent : "") + ", from Todoist"; }
    lsSet("atlas.keys", keys); closeKeys(); toast("Keys kept safe.");
    loadQuests(); if (keys.gclient && !gConnected()) gConnect(true);
  });

  /* ---------- Fireflies ---------- */
  (function () {
    const c = $("fireflies"); if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = c.getContext("2d"); let W, H, pts = [];
    function size() { W = c.width = innerWidth; H = c.height = innerHeight; pts = Array.from({ length: Math.min(60, Math.floor(W * H / 26000)) }, () => ({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - .5) * .3, vy: (Math.random() - .5) * .3, ph: Math.random() * Math.PI * 2, r: 1.2 + Math.random() * 1.6 })); }
    size(); addEventListener("resize", size);
    function tick(t) {
      if (document.hidden) { requestAnimationFrame(tick); return; }
      ctx.clearRect(0, 0, W, H);
      const dark = (matchMedia("(prefers-color-scheme: dark)").matches && document.documentElement.dataset.theme !== "light") || document.documentElement.dataset.theme === "dark";
      pts.forEach((p) => { p.x += p.vx; p.y += p.vy; if (p.x < 0) p.x = W; if (p.x > W) p.x = 0; if (p.y < 0) p.y = H; if (p.y > H) p.y = 0; const a = .25 + .45 * (.5 + .5 * Math.sin(t / 900 + p.ph)); ctx.beginPath(); ctx.fillStyle = dark ? "rgba(227,196,94," + a + ")" : "rgba(24,175,124," + a * .8 + ")"; ctx.shadowBlur = 10; ctx.shadowColor = dark ? "#e3c45e" : "#18af7c"; ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill(); });
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  })();

  /* ---------- Boot ---------- */
  renderHeader(); renderPortals(); renderDeeds(); renderSky(); renderOracleStored(); renderGStatus();
  loadWeather(); loadQuests();
  setInterval(() => { renderHeader(); renderTavern(); }, 60000);
  if (!keys.gclient && !keys.tdtoken) {
    banner("<b>Welcome, Guildmaster</b>This atlas needs its keys. Open the Keeper's Keys (the key button in the header) to connect Google Calendar and Todoist. The README in the repository walks through each step.<br><button class=\"primary\" type=\"button\" id=\"bannerKeys\">Open the Keeper's Keys</button>");
    $("bannerKeys").addEventListener("click", openKeys);
  }
  // Google: resume a stored token, or ask silently if we connected before.
  function bootGoogle(attempt) {
    if (gConnected()) { startGoogle(); return; }
    if (!keys.gclient) return;
    if (!gReady()) { if (attempt < 40) setTimeout(() => bootGoogle(attempt + 1), 250); return; }
    if (lsGet("atlas.gwas")) {
      makeTokenClient();
      banner("<b>Google Calendar</b>Your Google session needs a fresh sign-in to show the Tavern Board and Almanac.<br><button class=\"primary\" type=\"button\" id=\"bannerG\">Reconnect Google</button>");
      $("bannerG").addEventListener("click", () => gConnect(false));
      try { tokenClient.requestAccessToken({ prompt: "" }); } catch (e) { /* popup likely blocked; the banner button remains */ }
    }
  }
  bootGoogle(0);
  if ("serviceWorker" in navigator) { addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => {}); }); }
})();
