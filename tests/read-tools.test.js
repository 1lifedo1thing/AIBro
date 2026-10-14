const test = require('node:test');
const assert = require('node:assert/strict');
const ReadTools = require('../app/read-tools');

// A host double that records which module served each request. Every module is
// a plain stub; the registry must never reach past ctx for authority or state.
function host(overrides = {}) {
  const calls = [], validations = [];
  const run = { id: 'run-1', conversationId: 'c1' };
  const conversation = { id: 'c1' };
  const modules = {
    AgendaAccess: { execute: (request, options) => { calls.push(['agenda', request.type, options]); return { type: request.type }; } },
    ProjectAccess: { catalog: (state, request, owner) => { calls.push(['projects', owner.id]); return { type: 'project_list' }; } },
    TaskContext: { readCatalog: (state, conv, request, owner) => { calls.push(['tasks', conv.id, owner.id]); return { type: 'task_list' }; } },
    TerminalTools: { execute: (request, state, owner, options) => { calls.push(['terminal', options.toolCallId]); return { type: 'terminal' }; } },
    BrowserTools: { execute: request => { calls.push(['browser', request.type]); return { type: request.type }; } },
    AgentContext: { overview: () => { calls.push(['overview']); return { type: 'library_overview' }; }, readHistory: (conv, request) => { calls.push(['history', conv.id, request.type]); return { type: request.type }; } },
    VectorKnowledge: { searchRequest: async () => { calls.push(['vector']); return { type: 'search', strategy: 'hybrid' }; } },
    workstationDesktop: { marker: 'bridge' },
    ...overrides.modules,
  };
  const state = { agentRuns: [run, { id: 'run-0', conversationId: 'c1', contextCheckpoint: { workingSummary: 'earlier', ledger: Array.from({ length: 25 }, (_, i) => ({ i })) } }, { id: 'other', conversationId: 'c2' }] };
  const context = {
    run, conversation, scope: { projectId: 'p' }, signal: null, save: () => {}, refresh: () => {},
    fileContext: { read: request => { calls.push(['file', request.id]); return { type: 'read_file' }; } },
    getState: () => state,
    validate: () => validations.push(true),
    lookup: name => modules[name],
    agentContext: () => overrides.agentContext === undefined ? { capability: name => { calls.push(['capability', name]); return { type: 'capabilities', name }; } } : overrides.agentContext,
    fallback: request => { calls.push(['fallback', request.type]); return { type: request.type, fallback: true }; },
    ...overrides.context,
  };
  return { calls, validations, run, state, execute: ReadTools.create(context).execute };
}

test('each read type reaches its own module with the host run, scope and conversation', async () => {
  const h = host();
  for (const type of ['agenda_list', 'agenda_read', 'library_overview', 'capabilities', 'history_search', 'history_read', 'project_list', 'task_list', 'read_file', 'terminal', 'browser_open']) await h.execute({ type, id: 'x', name: 'tasks' }, { entry: { id: 'tool-7' } });
  assert.deepEqual(h.calls.map(call => call[0]), ['agenda', 'agenda', 'overview', 'capability', 'history', 'history', 'projects', 'tasks', 'file', 'terminal', 'browser']);
  const agenda = h.calls[0][2];
  assert.equal(agenda.run, h.run); assert.deepEqual(agenda.scope, { projectId: 'p' }); assert.equal(agenda.bridge.marker, 'bridge');
  assert.deepEqual(h.calls.find(call => call[0] === 'tasks'), ['tasks', 'c1', 'run-1']);
  assert.deepEqual(h.calls.find(call => call[0] === 'terminal'), ['terminal', 'tool-7'], 'terminal receives the scheduler entry id');
});

test('scope validation runs before any module, and a failed check reaches no module', async () => {
  const h = host({ context: { validate: () => { throw Object.assign(Error('scope changed'), { code: 'CANCELLED' }); } } });
  await assert.rejects(h.execute({ type: 'project_list' }), error => error.code === 'CANCELLED');
  assert.deepEqual(h.calls, []);
  const ok = host(); await ok.execute({ type: 'read' });
  assert.equal(ok.validations.length, 1);
});

test('hybrid search answers only when it returns a result; otherwise keyword reading serves it', async () => {
  const hybrid = host();
  assert.equal((await hybrid.execute({ type: 'search', query: 'q' })).strategy, 'hybrid');
  assert.deepEqual(hybrid.calls.map(call => call[0]), ['vector']);
  const declined = host({ modules: { VectorKnowledge: { searchRequest: async () => { declined.calls.push(['vector']); return null; } } } });
  assert.equal((await declined.execute({ type: 'search' })).fallback, true);
  assert.deepEqual(declined.calls.map(call => call[0]), ['vector', 'fallback']);
  const absent = host({ modules: { VectorKnowledge: undefined } });
  assert.equal((await absent.execute({ type: 'search' })).fallback, true);
  // Semantic search is never consulted for any other read type.
  const other = host(); await other.execute({ type: 'read' });
  assert.deepEqual(other.calls.map(call => call[0]), ['fallback']);
});

test('optional modules that are absent hand their request to keyword reading, as before', async () => {
  const h = host({ modules: { AgentContext: undefined, BrowserTools: undefined }, agentContext: null });
  for (const type of ['library_overview', 'history_read', 'capabilities', 'browser_open']) await h.execute({ type });
  assert.deepEqual(h.calls, [['fallback', 'library_overview'], ['fallback', 'history_read'], ['fallback', 'capabilities'], ['fallback', 'browser_open']]);
});

test('the agent context is read at call time, so a context created after the registry is used', async () => {
  let current = null;
  const h = host({ context: { agentContext: () => current } });
  assert.equal((await h.execute({ type: 'capabilities', name: 'tasks' })).fallback, true);
  current = { capability: name => ({ type: 'capabilities', name, live: true }) };
  assert.equal((await h.execute({ type: 'capabilities', name: 'tasks' })).live, true);
});

test('required modules fail visibly instead of falling through to another reader', async () => {
  const h = host({ modules: { ProjectAccess: undefined } });
  await assert.rejects(h.execute({ type: 'project_list' }), /ProjectAccess/);
  assert.deepEqual(h.calls, []);
});

test('evidence log pages the current run, reads only same-conversation runs and rejects bad cursors', async () => {
  const h = host();
  const own = await h.execute({ type: 'evidence_log' });
  assert.deepEqual([own.runId, own.total, own.nextOffset], ['run-1', 0, null]);
  const earlier = await h.execute({ type: 'evidence_log', runId: 'run-0', offset: 20 });
  assert.deepEqual([earlier.runId, earlier.workingSummary, earlier.total, earlier.entries.length, earlier.nextOffset], ['run-0', 'earlier', 25, 5, null]);
  assert.equal((await h.execute({ type: 'evidence_log', runId: 'run-0' })).nextOffset, 20);
  await assert.rejects(h.execute({ type: 'evidence_log', runId: 'other' }), /读取记录不在当前对话/);
  await assert.rejects(h.execute({ type: 'evidence_log', offset: -1 }), /Invalid evidence cursor/);
  await assert.rejects(h.execute({ type: 'evidence_log', offset: 1.5 }), /Invalid evidence cursor/);
});

test('unknown read types go to keyword reading, which owns their validation', async () => {
  const h = host();
  assert.equal((await h.execute({ type: 'memory_read' })).fallback, true);
  assert.equal((await h.execute({ type: 'neighbors' })).fallback, true);
});

test('a host missing required capabilities is refused at creation', () => {
  assert.throws(() => ReadTools.create({}), /missing run/);
  assert.throws(() => ReadTools.register('x', null), TypeError);
});
