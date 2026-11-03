/* Shared settings and completion accounting. No credentials enter synced progress. */
(function (root) {
  "use strict";
  const DAY = 86400000;
  function preferences(value = {}) {
    return { theme: ["dark", "light", "system"].includes(value.theme) ? value.theme : "dark", density: value.density === "comfortable" ? "comfortable" : "compact" };
  }
  function settingsExport(keys, prefs, state, includeSecrets, now = new Date()) {
    const settings = { gclient: keys.gclient, tdproject: keys.tdproject, amodel: keys.amodel, loc: keys.loc, appearance: preferences(prefs), bookmarks: state.bookmarks, calendars: state.cals };
    if (includeSecrets) { settings.tdtoken = keys.tdtoken; settings.akey = keys.akey; }
    return { format: "ryleyp-dashboard-settings", version: 1, exportedAt: now.toISOString(), includesSecrets: !!includeSecrets, settings };
  }
  function initProgress(state, now = Date.now()) {
    state.questCredits ||= {};
    state.todoistSync ||= { startedAt: now, projects: {} };
    state.todoistSync.projects ||= {};
    return state;
  }
  function applyCredit(state, id, entry) {
    if (Object.hasOwn(state.questCredits, id)) return false;
    state.questCredits[id] = entry;
    state.xp += entry.xp;
    state.completions[entry.day] = (state.completions[entry.day] || 0) + 1;
    state.log.push({ id, t: entry.t, w: entry.w, xp: entry.xp });
    state.log.sort((a, b) => b.t - a.t);
    state.log = state.log.slice(0, 40);
    return true;
  }
  function creditCompletions(state, items, projectId) {
    initProgress(state);
    let count = 0, xp = 0;
    for (const item of items) {
      const t = Date.parse(item.completed_at);
      if (!item.id || !Number.isFinite(t) || t < state.todoistSync.startedAt || String(item.project_id) !== String(projectId) || item.is_deleted) continue;
      const date = new Date(t);
      const day = date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
      const gain = ({ 4: 50, 3: 30, 2: 20, 1: 10 })[item.priority] || 10;
      // A recurring task keeps its ID, but each completion has its own timestamp.
      const id = String(item.id) + ":" + new Date(t).toISOString();
      if (applyCredit(state, id, { t, day, w: item.content || "Completed quest", xp: gain })) { count++; xp += gain; }
    }
    return { count, xp };
  }
  function mergeProgress(local, remote) {
    // Preserve the existing newest-settings policy, but union earned XP independently.
    const newer = (remote.savedAt || 0) > (local.savedAt || 0) ? remote : local;
    const other = newer === local ? remote : local;
    const merged = initProgress(JSON.parse(JSON.stringify(newer)));
    for (const [id, entry] of Object.entries(other.questCredits || {})) applyCredit(merged, id, entry);
    if (other.todoistSync) {
      merged.todoistSync.startedAt = Math.min(merged.todoistSync.startedAt, other.todoistSync.startedAt);
      for (const [project, checkpoint] of Object.entries(other.todoistSync.projects || {})) {
        // Re-read any range not confirmed by both devices; the ledger deduplicates it.
        merged.todoistSync.projects[project] = Math.min(merged.todoistSync.projects[project] || merged.todoistSync.startedAt, checkpoint);
      }
    }
    return merged;
  }
  async function completedHistory(request, projectId, since, until) {
    // Todoist permits at most three months per request. Use 30-day windows.
    const items = [];
    for (let start = since; start < until; start += 30 * DAY) {
      const end = Math.min(start + 30 * DAY, until);
      const params = new URLSearchParams({ project_id: projectId, since: new Date(start).toISOString(), until: new Date(end).toISOString(), limit: "200" });
      let cursor = null;
      const seen = new Set();
      do {
        if (cursor) params.set("cursor", cursor);
        const page = await request("/tasks/completed/by_completion_date?" + params);
        if (!page || !Array.isArray(page.items)) throw new Error("Unexpected Todoist completion history response");
        items.push(...page.items);
        cursor = page.next_cursor;
        if (cursor && seen.has(cursor)) throw new Error("Todoist repeated a completion history page");
        if (cursor) seen.add(cursor);
      } while (cursor);
    }
    return items;
  }
  const api = { preferences, settingsExport, initProgress, creditCompletions, mergeProgress, completedHistory };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DashboardData = api;
})(globalThis);
