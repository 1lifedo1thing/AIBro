'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Core = require('../app/workstation-core.js');
const PrivateMode = require('../app/private-mode.js');
const Evidence = require('../app/citation-evidence.js');

// Execute the production native privacy projection, without launching a GUI.
const bridge = fs.readFileSync(require.resolve('../native/Resources/bridge.js'), 'utf8');
const start = bridge.indexOf('function nativePrivacy(state){');
const end = bridge.indexOf('\nconst conversationPreviewCache=', start);
assert.ok(start >= 0 && end > start);
const nativePrivacy = vm.runInNewContext(bridge.slice(start, end) + '\nnativePrivacy;');
const reload = state => JSON.parse(JSON.stringify(state));
function fixture(privateMode = false, { ancestry, provenanceRun = true } = {}) {
  let state = { projects: [], imports: [], notes: [], tasks: [], links: [], conversations: [], agentRuns: [], trash: [] };
  PrivateMode.init({ getState: () => state, save() {} }); PrivateMode.setEnabled(false);
  if (privateMode) PrivateMode.setEnabled(true);
  const conversation = { id: 'origin-chat', workspace: '日常', messages: [] };
  PrivateMode.mark(conversation); state.conversations.push(conversation);
  const run = { id: 'origin-run', conversationId: conversation.id, workspace: '日常', startedAt: 10,
    goal: 'DO_NOT_COPY_GOAL', rawOutput: 'DO_NOT_COPY_OUTPUT', modelConfig: { token: 'DO_NOT_COPY_TOKEN' } };
  if (ancestry) ancestry(state, conversation, run);
  state.agentRuns.push(run); let counter = 0;
  const context = { workspace: '日常', conversationId: conversation.id, projectId: run.projectId, runId: run.id,
    ...(provenanceRun ? { provenanceRun: run } : {}), now: 20, uid: prefix => prefix + '-' + ++counter };
  return { get state() { return state; }, run, conversation, context,
    apply(actions = [{ type: 'create_project', name: 'Created project' }]) { const outcome = Core.applyPlan(state, actions, context); state = outcome.state; return outcome; },
    purge() { return PrivateMode.purge(); } };
}
function assertPrivateProject(state, project, expected) {
  assert.equal(Evidence.access(state, { type: 'local', projectId: project.id }).kind === 'private', expected, 'shared read guard');
  assert.equal(nativePrivacy(state)('projects', project.id), expected, 'production native project guard');
}

test('a real PrivateMode-created project retains private origin through purge and JSON reload', () => {
  for (const provenanceRun of [true, false]) {
    const f = fixture(true, { provenanceRun }), before = JSON.stringify(f.state);
    const outcome = f.apply(), project = outcome.state.projects[0];
    assert.equal(outcome.results[0].operation, 'created'); assert.ok(before.includes('"ephemeral":true'));
    assert.equal(project.provenance?.origin?.private, true);
    assert.equal(project.provenance.origin.conversationId, f.conversation.id);
    assert.equal(project.provenance.origin.runId, f.run.id);
    assertPrivateProject(f.state, project, true);
    assert.deepEqual(f.purge(), { removedConversations: 1, removedRuns: 1 });
    const disk = reload(f.state), retained = disk.projects.find(value => value.id === project.id);
    assert.ok(retained); assert.equal(disk.conversations.length, 0); assert.equal(disk.agentRuns.length, 0);
    assertPrivateProject(disk, retained, true);
    assert.doesNotMatch(JSON.stringify(retained.provenance), /DO_NOT_COPY|modelConfig|rawOutput|inputs|outputStamp/);
    PrivateMode.setEnabled(false);
  }
});

test('public projects remain public and readable when their recorded source is later removed', () => {
  const f = fixture(false); f.apply(); const project = f.state.projects[0];
  assert.equal(project.provenance?.origin?.conversationId, f.conversation.id);
  assert.equal(project.provenance.origin.private, undefined);
  assert.deepEqual(f.purge(), { removedConversations: 0, removedRuns: 0 });
  f.state.conversations = []; f.state.agentRuns = []; f.state.trash = [];
  const disk = reload(f.state); assertPrivateProject(disk, disk.projects[0], false);
  assert.equal(Evidence.access(disk, { type: 'local', projectId: project.id }).available, true);
});

test('project creation captures inherited privacy through the existing provenance ancestry guard', () => {
  for (const ancestry of [
    (state, chat, run) => { state.projects.push({ id: 'private-parent', name: 'Parent', private: true }); chat.projectId = run.projectId = 'private-parent'; },
    (_state, chat) => { chat.provenance = { origin: { private: true } }; },
    (_state, _chat, run) => { run.incognito = true; },
    (state, _chat, run) => { run.runId = 'retired-run'; state.trash.push({ data: { runs: [{ id: 'retired-run', private: true }] } }); }
  ]) {
    const f = fixture(false, { ancestry }); f.apply(); const project = f.state.projects.find(value => value.name === 'Created project');
    assert.equal(project.provenance?.origin?.private, true);
    f.state.conversations = []; f.state.agentRuns = []; f.state.trash = [];
    f.state.projects = [project]; const disk = reload(f.state); assertPrivateProject(disk, disk.projects[0], true);
  }
});

test('matching a public project from a private conversation does not relabel its existing provenance', () => {
  const f = fixture(true), prior = { id: 'existing', name: 'Created project', workspace: '日常', description: 'Public project',
    provenance: { origin: { recorded: true, conversationId: 'earlier-public-chat' } } };
  f.state.projects.push(prior); const saved = JSON.stringify(prior.provenance), outcome = f.apply();
  assert.equal(outcome.results[0].operation, 'matched'); assert.equal(JSON.stringify(outcome.state.projects[0].provenance), saved);
  assert.equal(outcome.state.projects[0].sourceConversationId, undefined);
  f.purge(); assertPrivateProject(reload(f.state), prior, false); PrivateMode.setEnabled(false);
});

test('invalid later actions keep project origin and project creation inside the cloned transaction', () => {
  const f = fixture(true), before = JSON.stringify(f.state);
  assert.throws(() => f.apply([{ type: 'create_project', name: 'Never committed' }, { type: 'create_task', title: '' }]), /不能为空/);
  assert.equal(JSON.stringify(f.state), before); PrivateMode.setEnabled(false);
});

test('legacy projects with already missing origins stay public rather than guessing a private migration', () => {
  const f = fixture(false); f.state.projects.push({ id: 'legacy', name: 'Legacy public project', sourceConversationId: 'gone', workspace: '日常' });
  f.state.conversations = []; f.state.agentRuns = []; const disk = reload(f.state);
  assertPrivateProject(disk, disk.projects[0], false);
});

test('project privacy trusts host identities instead of model metadata or a different run receipt', () => {
  const privateFlow = fixture(true);
  privateFlow.apply([{ type: 'create_project', name: 'Created project', private: false, provenance: { origin: { private: false, conversationId: 'forged-public' } } }]);
  assert.equal(privateFlow.state.projects[0].provenance.origin.private, true);
  assert.equal(privateFlow.state.projects[0].provenance.origin.conversationId, privateFlow.conversation.id);
  privateFlow.purge(); PrivateMode.setEnabled(false);
  const publicFlow = fixture(false); publicFlow.context.provenanceRun = { id: 'different-run', private: true };
  publicFlow.apply([{ type: 'create_project', name: 'Created project', private: true, provenance: { origin: { private: true } } }]);
  assert.equal(publicFlow.state.projects[0].provenance.origin.private, undefined);
  assertPrivateProject(publicFlow.state, publicFlow.state.projects[0], false);
});
