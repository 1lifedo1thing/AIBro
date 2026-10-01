const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
function fixture() {
  const events = [], calls = [], notices = [];
  const env = { storageHydrated: true, serverConflict: false, state: { notes: [{ id: 'n', title: 'Result' }], projects: [] },
    window: { WorkstationRunHistory: require('../app/run-history.js') },
    document: { dispatchEvent: event => events.push(event.type) }, CustomEvent: class { constructor(type) { this.type = type; } },
    toast: value => notices.push(value), openSearchResult: async value => { calls.push(value); return true; } };
  for (const name of ['openActivityTarget', 'openHistoryResult']) {
    const body = source.match(new RegExp(`async function ${name}\\([^]*?\\n\\}`))[0];
    vm.runInNewContext(body, env);
  }
  return { env, events, calls, notices };
}
test('history result reveals the native destination only after the awaited reader gate succeeds', async () => {
  const f = fixture(); let resolve;
  f.env.openSearchResult = value => { f.calls.push(value); return new Promise(done => resolve = done); };
  const pending = f.env.openHistoryResult('note', 'n');
  assert.deepEqual(f.calls, ['note:n']); assert.deepEqual(f.events, []);
  resolve(true); assert.equal(await pending, true);
  assert.deepEqual(f.events, ['aibro-command-search-success']);
});
test('cancelled draft decision, unavailable result or private mode never reroutes the native shell', async () => {
  const f = fixture();
  f.env.openSearchResult = async () => false;
  assert.equal(await f.env.openHistoryResult('note', 'n'), false);
  f.env.state.notes[0].deletedAt = 1;
  assert.equal(await f.env.openHistoryResult('note', 'n'), false); assert.equal(f.notices.length, 1);
  delete f.env.state.notes[0].deletedAt;
  f.env.window.PrivateMode = { isOn: () => true };
  assert.equal(await f.env.openHistoryResult('note', 'n'), false);
  assert.deepEqual(f.events, []);
});
test('history original conversation uses the same native navigation owner', () => {
  assert.match(source, /WorkstationRunHistory\?\.init\(\{ getState: \(\) => state, openConversation: id => openActivityTarget\(\{ kind: 'conversation', id \}\), openResult: openHistoryResult/);
});
