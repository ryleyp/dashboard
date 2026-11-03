const { test } = require('node:test');
const assert = require('node:assert/strict');
const { initProgress, creditCompletions, mergeProgress, completedHistory, settingsExport, preferences } = require('../dashboard-data.js');
const start = Date.parse('2026-10-01T00:00:00Z');
const fresh = () => initProgress({ xp: 90, completions: { '2026-09-30': 3 }, log: [], savedAt: 1 }, start);
const task = (id = 'one', date = '2026-10-02T12:00:00Z', priority = 4) => ({ id, completed_at: date, priority, project_id: 'work', content: 'Ship it' });

test('external completion credits priority XP once, including after persistence and repeated refresh', () => {
  let state = fresh();
  assert.deepEqual(creditCompletions(state, [task(), task()], 'work'), { count: 1, xp: 50 });
  state = JSON.parse(JSON.stringify(state));
  assert.deepEqual(creditCompletions(state, [task()], 'work'), { count: 0, xp: 0 });
  assert.equal(state.xp, 140);
  assert.equal(state.log.length, 1);
});
test('each recurring completion counts separately on its completion day, not its due day', () => {
  const state = fresh();
  const second = task('one', '2026-10-03T12:00:00Z', 2);
  second.due = { date: '2026-12-01', is_recurring: true };
  creditCompletions(state, [task(), second], 'work');
  assert.equal(state.xp, 160);
  assert.equal(state.completions['2026-10-02'], 1);
  assert.equal(state.completions['2026-10-03'], 1);
  assert.equal(state.completions['2026-12-01'], undefined);
});
test('old, invalid, deleted and other-project tasks never earn XP', () => {
  const state = fresh();
  const items = [task('old', '2026-09-29T12:00:00Z'), task('bad', 'invalid'), { ...task('wrong'), project_id: 'personal' }, { ...task('deleted'), is_deleted: true }, { ...task(), id: null }];
  assert.equal(creditCompletions(state, items, 'work').count, 0);
  assert.equal(state.xp, 90);
});
test('priority mapping and completion-time ordering are preserved', () => {
  const state = fresh();
  creditCompletions(state, [1, 2, 3, 4].map(p => task(String(p), `2026-10-0${p + 1}T12:00:00Z`, p)), 'work');
  assert.equal(state.xp, 200);
  assert.deepEqual(state.log.map(e => e.xp), [50, 30, 20, 10]);
});
test('merging overlapping device ledgers preserves unique credits and newest settings', () => {
  const a = fresh(), b = fresh();
  a.savedAt = 10; b.savedAt = 20; a.bookmarks = ['old']; b.bookmarks = ['new'];
  creditCompletions(a, [task('shared'), task('a')], 'work');
  creditCompletions(b, [task('shared'), task('b')], 'work');
  const merged = mergeProgress(a, b);
  assert.equal(merged.xp, 240);
  assert.equal(merged.completions['2026-10-02'], 3);
  assert.deepEqual(merged.bookmarks, ['new']);
  assert.equal(mergeProgress(merged, a).xp, 240);
  assert.equal(mergeProgress(merged, b).xp, 240);
  assert.equal(a.xp, 190);
});
test('legacy progress survives migration and merge', () => {
  const remote = { xp: 500, completions: { '2026-09-30': 20 }, log: [], savedAt: 2 };
  const local = fresh();
  creditCompletions(local, [task()], 'work');
  const merged = mergeProgress(local, remote);
  assert.equal(merged.xp, 550);
  assert.equal(merged.todoistSync.startedAt, start);
});
test('history walks every cursor and divides long absences into valid windows', async () => {
  const calls = [];
  const result = await completedHistory(async path => {
    const url = new URL(path, 'https://test.invalid'); calls.push(url);
    return url.searchParams.has('cursor') ? { items: [task('two')], next_cursor: null } : { items: [task()], next_cursor: 'page2' };
  }, 'work', start, start + 65 * 86400000);
  assert.equal(calls.length, 6); assert.equal(result.length, 6);
  calls.forEach(url => {
    assert.equal(url.searchParams.get('project_id'), 'work');
    assert.ok(Date.parse(url.searchParams.get('until')) - Date.parse(url.searchParams.get('since')) <= 30 * 86400000);
  });
  assert.equal(calls[2].searchParams.get('since'), calls[0].searchParams.get('until'));
});
test('a failing later page or repeated cursor rejects the batch, so caller cannot advance checkpoint', async () => {
  let count = 0;
  await assert.rejects(completedHistory(async () => { if (++count === 2) throw new Error('offline'); return { items: [task()], next_cursor: 'two' }; }, 'work', start, start + 1000), /offline/);
  await assert.rejects(completedHistory(async () => ({ items: [], next_cursor: 'same' }), 'work', start, start + 1000), /repeated/);
  await assert.rejects(completedHistory(async () => ({}), 'work', start, start + 1000), /Unexpected/);
});
test('settings export allowlists values and excludes secrets and progress unless explicitly requested', () => {
  const keys = { gclient: 'client', tdproject: 'work', amodel: 'model', loc: { name: 'Austin' }, tdtoken: 'todoist-secret', akey: 'anthropic-secret', token: 'oauth-secret' };
  const state = { bookmarks: [{ n: 'Work', u: 'https://example.com' }], cals: { one: false }, xp: 900, gtoken: 'google-secret' };
  const safe = settingsExport(keys, {}, state, false);
  assert.equal(safe.version, 1);
  assert.equal(safe.includesSecrets, false);
  assert.equal(JSON.stringify(safe).includes('secret'), false);
  assert.equal(safe.settings.xp, undefined);
  const privateExport = settingsExport(keys, {}, state, true);
  assert.equal(privateExport.settings.tdtoken, 'todoist-secret');
  assert.equal(privateExport.settings.akey, 'anthropic-secret');
  assert.equal(JSON.stringify(privateExport).includes('oauth-secret'), false);
  assert.deepEqual(preferences({ theme: 'bogus', density: 'bogus' }), { theme: 'dark', density: 'compact' });
});
