const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../app/artifact-provenance');
const Core = require('../app/workstation-core');
const Evidence = require('../app/citation-evidence');
const Wiki = require('../app/research-wiki');
const Editor = require('../app/note-editor');
const DraftReview = require('../app/draft-review');
const Catalog = require('../app/document-files');
const PrivateMode = require('../app/private-mode');

function fixture() {
  const run = {id: 'run-one', conversationId: 'chat-one', userMessageId: 'user-one', projectId: 'project', workspace: '科研', status: 'running', startedAt: 1,
    modelConfig: {provider: 'api', model: 'synthetic-model', effort: 'high', token: 'SECRET_CONFIG'}, goal: 'SECRET_USER_PROMPT', rawOutput: 'SECRET_MODEL_OUTPUT'};
  const state = {projects: [{id: 'project', workspace: '科研'}], tasks: [], notes: [{id: 'source-note', title: 'Input note', content: 'Real request-time note body', workspace: '科研', projectId: 'project'}],
    papers: [], imports: [{id: 'source-pdf', name: 'Input.pdf', content: 'Indexed original text', workspace: '科研', projectId: 'project', pageCount: 12}], attachments: [], links: [], trash: [], agentRuns: [run],
    conversations: [{id: 'chat-one', projectId: 'project', workspace: '科研', messages: [{id: 'user-one', role: 'user', text: 'SECRET_USER_PROMPT'}]}]};
  Evidence.capture(run, {type: 'note', id: 'source-note', title: 'Input note', offset: 0, excerpt: 'Real request-time note body'}, state);
  Evidence.capture(run, {type: 'import', id: 'source-pdf', title: 'Input.pdf', page: 3, media: 'page_image'}, state);
  let sequence = 0;
  const context = (r = run, extra = {}) => ({workspace: '科研', projectId: 'project', conversationId: r.conversationId, runId: r.id, provenanceRun: r, uid: prefix => prefix + '-' + ++sequence, now: 10, ...extra});
  return {state, run, context};
}
const noteAction = {type: 'create_knowledge_item', title: 'Research summary', content: 'A derived analysis that can be inspected.', sourceAttachmentIds: ['source-pdf']};
function created() { const f = fixture(), outcome = Core.applyPlan(f.state, [noteAction], f.context()); f.state = outcome.state; f.note = f.state.notes.find(note => note.title === noteAction.title); return f; }
const project = f => P.project(f.state, {type: 'note', id: f.note.id});
const sortedRoundtrip = value => JSON.parse(JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item));

test('paper input and output versions survive reordered persistence keys but detect real content edits', () => {
  const f = fixture();
  const paper = {id: 'source-paper', title: 'Paper input', projectId: 'project', structured: {z: {last: 1, first: 2}, a: 'Method'}, userEdits: {summary: 'Summary', problem: 'Problem'}};
  f.state.papers.push(paper);
  const evidence = Evidence.capture(f.run, {type: 'paper', id: paper.id, excerpt: 'Method'}, f.state);
  assert.equal(evidence.bodyFormat, 'canonical-v1');
  P.attach(f.state, f.run, {type: 'paper', id: paper.id, record: paper, at: 9});
  const outcome = Core.applyPlan(f.state, [noteAction], f.context());
  const reloaded = sortedRoundtrip(outcome.state), note = reloaded.notes.find(item => item.title === noteAction.title);
  assert.equal(P.project(reloaded, {type: 'paper', id: paper.id}).bodyChanged, false);
  assert.equal(P.project(reloaded, {type: 'note', id: note.id}).inputs.find(item => item.type === 'paper').status, 'current');
  assert.equal(Evidence.status(evidence, reloaded).kind, 'snapshot');
  reloaded.papers[0].structured.z.first = 3;
  assert.equal(P.project(reloaded, {type: 'paper', id: paper.id}).bodyChanged, true);
  assert.equal(P.project(reloaded, {type: 'note', id: note.id}).inputs.find(item => item.type === 'paper').status, 'changed');
  assert.equal(Evidence.status(evidence, reloaded).kind, 'changed');
});

test('legacy paper input fingerprints cannot claim unchanged content after persistence', () => {
  const f = fixture(); f.state.papers.push({id: 'source-paper', title: 'Paper input', structured: {z: 1, a: 2}});
  const source = Evidence.capture(f.run, {type: 'paper', id: 'source-paper', excerpt: 'Original excerpt'}, f.state);
  delete source.bodyFormat;
  const outcome = Core.applyPlan(f.state, [noteAction], f.context()), note = outcome.state.notes.at(-1);
  const row = P.project(outcome.state, {type: 'note', id: note.id}).inputs.find(item => item.type === 'paper');
  assert.equal(row.status, 'unrecorded'); assert.match(row.detail, /旧版指纹/);
});

test('actual host hydration preserves artifact and draft provenance through its record normalization', () => {
  const f = fixture(), vm = require('node:vm'), fs = require('node:fs');
  const outcome = Core.applyPlan(f.state, [noteAction, {type: 'create_task', title: 'Inspect', checklist: ['Read result']},
    {type: 'upsert_paper', title: 'Paper result', sourceAttachmentIds: ['source-pdf'], structured: {methods: {text: 'Actual method'}}}], f.context());
  const note = outcome.state.notes.find(item => item.title === noteAction.title);
  note.aiDraft = {title: note.title, content: 'Pending version'};
  P.attach(outcome.state, f.run, {type: 'note', id: note.id, record: note, variant: 'draft', operation: 'drafted', at: 11});
  note.revisionHistory = [{content: note.content, provenance: structuredClone(note.provenance)}];
  note.aiDraftHistory = [{action: 'extended', draft: structuredClone(note.aiDraft)}];
  const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
  const start = source.indexOf('function normalizeStateShape('), end = source.indexOf('\ntry { normalizeStateShape(', start);
  assert.ok(start >= 0 && end > start);
  const host = vm.createContext({state: {}, window: {}, Core, Research: require('../app/research-library'), uid: type => type + '-hydrated', workspaceName: value => value || '日常'});
  vm.runInContext(source.slice(start, end), host);
  const hydrated = host.normalizeStateShape(sortedRoundtrip(outcome.state)), current = hydrated.notes.find(item => item.id === note.id);
  for (const field of ['provenance', 'aiDraft', 'revisionHistory', 'aiDraftHistory']) assert.deepEqual(current[field], sortedRoundtrip(note[field]));
  for (const [type, values] of [['note', hydrated.notes], ['paper', hydrated.papers], ['task', hydrated.tasks]]) {
    for (const item of values.filter(value => value.provenance)) assert.equal(P.project(hydrated, {type, id: item.id}).bodyChanged, false, `${type}:${item.id}`);
  }
  assert.equal(P.project(hydrated, {type: 'note', id: note.id}, {variant: 'draft'}).bodyChanged, false);
});

test('Core captures note, task, Wiki, paper and paper-note origins in the same cloned transaction', () => {
  const f = fixture(), before = JSON.stringify(f.state);
  const outcome = Core.applyPlan(f.state, [noteAction, {type: 'create_task', title: 'Inspect result', sourceAttachmentIds: ['source-pdf']},
    {type: 'upsert_wiki', wikiType: 'method', title: 'Typed Wiki', sections: {principle: 'Observed principle'}, sourceNoteIds: ['source-note']},
    {type: 'upsert_paper', title: 'Synthetic paper', sourceAttachmentIds: ['source-pdf'], structured: {methods: {text: 'Actual analysis'}}}], f.context());
  const records = [['note', outcome.state.notes.filter(note => note.id !== 'source-note')], ['paper', outcome.state.papers], ['task', outcome.state.tasks]];
  for (const [type, values] of records) for (const record of values) {
    assert.equal(record.provenance.origin.runId, f.run.id);
    assert.deepEqual(record.provenance.output, {type, id: record.id, variant: 'body'});
    assert.equal(P.project(outcome.state, {type, id: record.id}).bodyChanged, false);
  }
  assert.equal(outcome.state.papers[0].agentRunId, f.run.id);
  assert.equal(JSON.stringify(f.state), before, 'The original state is untouched before the host commits the transaction');
});

test('capture uses only request-time evidence and never samples current input content or global deletion snapshots', () => {
  const f = fixture(); f.state.notes[0].content = 'Replaced after the request';
  f.run.attachmentSnapshots = {'unread-secret-source': 'unrelated scope stamp'};
  const outcome = Core.applyPlan(f.state, [noteAction], f.context()), note = outcome.state.notes.at(-1);
  const view = P.project(outcome.state, {type: 'note', id: note.id});
  assert.equal(view.inputs.find(row => row.type === 'note').status, 'changed');
  assert.equal(view.inputs.find(row => row.type === 'import').status, 'unrecorded', 'A text index hash never certifies unchanged PDF bytes');
  assert.equal(view.inputs.find(row => row.type === 'import').page, 3);
  assert.equal(view.inputs.length, 2);
  assert.doesNotMatch(JSON.stringify(note.provenance), /SECRET_|Replaced after|Real request-time|Indexed original|unread-secret-source|rawOutput|token/);
});

test('a retained artifact keeps bounded origin and source versions when its local run log is deleted', () => {
  const f = created(); f.state.agentRuns = [];
  const view = project(f);
  assert.equal(view.recordKind, 'recorded'); assert.equal(view.origin.runId, 'run-one');
  assert.equal(view.origin.runAvailable, false); assert.equal(view.origin.conversationAvailable, true);
  assert.equal(view.inputs[0].status, 'current');
  f.state.conversations = [];
  assert.equal(project(f).origin.conversationAvailable, false); assert.equal(project(f).recordKind, 'recorded');
});

test('a second run drafts separately, adoption promotes its origin and keeps the previous body origin in history', () => {
  const f = created(), r2 = {...f.run, id: 'run-two', conversationId: 'chat-two', userMessageId: 'user-two'};
  f.state.agentRuns.push(r2); f.state.conversations.push({id: 'chat-two', projectId: 'project', messages: []});
  f.state = Core.applyPlan(f.state, [{type: 'append_note', noteId: f.note.id, content: 'New material from the second run'}], f.context(r2, {protectNoteUpdates: true, now: 20})).state;
  f.note = f.state.notes.find(note => note.id === f.note.id);
  assert.equal(f.note.provenance.origin.runId, 'run-one'); assert.equal(f.note.aiDraft.provenance.origin.runId, 'run-two');
  assert.equal(project(f).hasDraft, true);
  assert.equal(P.project(f.state, {type: 'note', id: f.note.id}, {variant: 'draft'}).origin.runId, 'run-two');
  const review = DraftReview.begin(f.state, f.note.id), discarded = DraftReview.prepare(f.state, review, 'discard', 21);
  assert.equal(discarded.after.provenance.origin.runId, 'run-one');
  const adopted = DraftReview.prepare(f.state, review, 'adopt', 22);
  assert.equal(adopted.after.provenance.origin.runId, 'run-two');
  assert.equal(adopted.after.provenance.output.variant, 'body');
  assert.equal(adopted.after.revisionHistory.at(-1).provenance.origin.runId, 'run-one');
  f.state.notes = f.state.notes.map(note => note.id === f.note.id ? adopted.after : note);
  assert.equal(project(f).origin.runId, 'run-two'); assert.equal(project(f).bodyChanged, false);
});

test('Wiki whole-read guarded drafts and their extended history retain separate run origins', () => {
  const f = fixture(), action = {type: 'upsert_wiki', wikiType: 'method', title: 'Method memory', sections: {principle: 'Initial observation'}};
  f.state = Core.applyPlan(f.state, [action], f.context()).state;
  const note = f.state.notes.at(-1), r2 = {...f.run, id: 'run-two'};
  const update = {...action, noteId: note.id, baseUpdatedAt: note.updatedAt, sections: Object.fromEntries(Object.keys(Wiki.fields('method')).map(key => [key, 'Preserved and expanded observation']))};
  const outcome = Core.applyPlan(f.state, [update], f.context(r2, {protectNoteUpdates: true, wikiReadVersions: {[note.id]: Wiki.revision(note)}, now: 20}));
  const changed = outcome.state.notes.at(-1);
  assert.equal(changed.provenance.origin.runId, 'run-one'); assert.equal(changed.aiDraft.provenance.origin.runId, 'run-two');
  assert.equal(changed.content, note.content);
});

test('manual edits keep the original receipt but visibly mark that the body has changed; unknown drafts inherit no origin proof', () => {
  const f = created(), session = Editor.begin(f.state, f.note.id); session.content = 'My own changed body';
  const change = Editor.prepare(f.state, session, 20);
  f.state.notes = f.state.notes.map(note => note.id === f.note.id ? change.after : note);
  assert.equal(project(f).bodyChanged, true); assert.equal(change.after.revisionHistory.at(-1).provenance.origin.runId, 'run-one');
  const latest = f.state.notes.at(-1); latest.aiDraft = {content: 'Legacy draft without provenance', title: latest.title};
  const draft = DraftReview.prepare(f.state, DraftReview.begin(f.state, latest.id), 'adopt', 30);
  assert.equal(draft.after.provenance, null);
});

test('provenance participates in editor conflict detection before adoption or save', () => {
  const f = created(), session = Editor.begin(f.state, f.note.id); session.content += ' edit';
  f.note.provenance.origin.runId = 'another-writer';
  assert.throws(() => Editor.prepare(f.state, session), /其他操作修改/);
});

test('matched output does not overwrite origin and a rejected transaction records nothing', () => {
  const f = created(), r2 = {...f.run, id: 'run-two'};
  const matched = Core.applyPlan(f.state, [noteAction], f.context(r2));
  assert.equal(matched.state.notes.at(-1).provenance.origin.runId, 'run-one');
  const before = JSON.stringify(f.state);
  assert.throws(() => Core.applyPlan(f.state, [noteAction, {type: 'create_task', title: 'Invalid', priority: 'invented'}], f.context()), /优先级/);
  assert.equal(JSON.stringify(f.state), before);
});

test('model-supplied paper origin cannot override host identity', () => {
  const f = fixture();
  const result = Core.applyPlan(f.state, [{type: 'upsert_paper', title: 'Paper', sourceAttachmentIds: ['source-pdf'], agentRunId: 'FAKE', sourceConversationId: 'FAKE',
    provenance: {version: 1, origin: {recorded: true, runId: 'FAKE'}}, structured: {methods: 'Meaningful analysis'}}], f.context()).state;
  assert.equal(result.papers[0].agentRunId, 'run-one'); assert.equal(result.papers[0].sourceConversationId, 'chat-one');
  assert.equal(result.papers[0].provenance.origin.runId, 'run-one'); assert.doesNotMatch(JSON.stringify(result.papers[0]), /FAKE/);
});

test('source private, hidden, archived, deleted and duplicate identity redact saved titles and positions without a replacement target', () => {
  for (const mutate of [s => s.notes[0].private = true, s => s.notes[0].hidden = true, s => s.notes[0].archived = true,
    s => s.notes[0].deletedAt = 2, s => s.notes.push({...s.notes[0]}), s => s.notes.splice(0, 1),
    s => {s.notes[0].projectId = 'private-project'; s.projects.push({id: 'private-project', private: true});}]) {
    const f = created(); f.note.provenance.inputs[0].title = 'SECRET_SAVED_SOURCE'; mutate(f.state);
    const input = project(f).inputs[0];
    assert.equal(input.available, false); assert.equal(input.status, 'unavailable'); assert.equal(input.page, null); assert.equal(input.offset, null);
    assert.doesNotMatch(JSON.stringify(input), /SECRET_SAVED_SOURCE|Input note|Real request-time/);
  }
});

test('artifact owner privacy and duplicate artifact identities fail closed before exposing a snapshot', () => {
  for (const mutate of [f => f.note.private = true, f => f.note.hidden = true, f => f.note.archived = true,
    f => f.state.notes.push({...f.note}), f => f.state.conversations[0].private = true, f => f.state.projects[0].archived = true]) {
    const f = created(); mutate(f); const view = project(f);
    assert.equal(view.available, false); assert.equal(view.hasDraft, false); assert.equal(view.inputs.length, 0);
    assert.doesNotMatch(JSON.stringify(view), /Research summary|synthetic-model|Input note/);
  }
});

test('origin navigation checks exact run/conversation identity and owning project lifecycle', () => {
  const f = created(); assert.equal(project(f).origin.runAvailable, true);
  f.state.agentRuns[0].projectId = 'old'; f.state.projects.push({id: 'old', archived: true});
  assert.equal(project(f).origin.runAvailable, false); assert.equal(project(f).origin.conversationAvailable, true);
  f.state.agentRuns[0].projectId = 'project'; f.state.agentRuns.push({...f.state.agentRuns[0]});
  assert.equal(project(f).origin.runAvailable, false);
  f.state.conversations.push({...f.state.conversations[0]}); assert.equal(project(f).origin.conversationAvailable, false);
});

test('copied receipt identity never certifies a different artifact or a different body/draft variant', () => {
  const f = created(), second = {...f.note, id: 'another-note'}; f.state.notes.push(second);
  assert.notEqual(P.project(f.state, {type: 'note', id: second.id}).recordKind, 'recorded');
  f.note.aiDraft = {title: f.note.title, content: f.note.content, provenance: structuredClone(f.note.provenance)};
  assert.notEqual(P.project(f.state, {type: 'note', id: f.note.id}, {variant: 'draft'}).recordKind, 'recorded');
});

test('legacy projection uses exact typed results only and does not invent input history from current links or a similar title', () => {
  const f = created(); delete f.note.provenance; delete f.note.agentRunId; delete f.note.sourceConversationId;
  f.run.results = [{type: 'task', id: f.note.id, operation: 'created'}]; f.state.agentRuns = [f.run];
  assert.equal(project(f).recordKind, 'unrecorded'); assert.equal(project(f).inputs.length, 0);
  assert.equal(project(f).related[0].status, 'unrecorded');
  f.run.results = [{type: 'note', id: f.note.id, operation: 'created'}];
  assert.equal(project(f).recordKind, 'legacy-linked'); assert.equal(project(f).origin.recorded, false);
  assert.equal(project(f).origin.runId, 'run-one'); assert.equal(project(f).inputs.length, 0);
});

test('merged aliases, incomplete or malformed stored input metadata cannot substitute another source or crash the inspector', () => {
  const f = created(); f.note.provenance.inputs.push(null, 1, {}, {type: 'constructor', id: 'x'});
  assert.doesNotThrow(() => project(f)); assert.equal(project(f).inputs.length, 2);
  const id = f.note.id; f.state.notes = f.state.notes.filter(note => note.id !== id); f.state.notes.push({...f.note, id: 'canonical'});
  f.state._noteAliases = {[id]: 'canonical'};
  assert.equal(P.project(f.state, {type: 'note', id}).available, false);
});

test('provided body and draft evidence compare independently and historical wrong draft hashes remain unknown', () => {
  const f = fixture(); f.state.notes[0].aiDraft = {content: 'Request draft'};
  const entry = Evidence.capture(f.run, {type: 'note', id: 'source-note', title: 'Draft', variant: 'draft', excerpt: 'Request draft', offset: 0}, f.state);
  f.state = Core.applyPlan(f.state, [noteAction], f.context()).state; const note = f.state.notes.at(-1);
  const view = () => P.project(f.state, {type: 'note', id: note.id});
  assert.equal(view().inputs.find(row => row.variant === 'draft').status, 'current');
  f.state.notes[0].aiDraft.content = 'Changed draft';
  assert.equal(view().inputs.find(row => row.variant === 'draft').status, 'changed');
  assert.equal(view().inputs.find(row => row.type === 'note' && row.variant === 'current').status, 'current');
  delete entry.bodyVariant;
  const old = P.capture(f.state, f.run, {type: 'note', id: note.id, record: note}); note.provenance = old;
  assert.equal(view().inputs.find(row => row.variant === 'draft').status, 'unrecorded');
});

test('many page receipts hash each current source body once per projection and observe later in-place edits', () => {
  const f = created(), template = f.note.provenance.inputs[0];
  f.note.provenance.inputs = Array.from({length: 100}, (_, page) => ({...template, page: page + 1, sourceId: 'page-' + page}));
  let reads = 0, content = f.state.notes[0].content;
  Object.defineProperty(f.state.notes[0], 'content', {get: () => {reads++; return content;}, configurable: true});
  assert.ok(project(f).inputs.every(row => row.status === 'current')); assert.equal(reads, 1);
  content = 'Edited in place'; assert.ok(project(f).inputs.every(row => row.status === 'changed')); assert.equal(reads, 2);
});

test('all supplied page metadata survives capture, deduplication, projection and restart without copying source text', () => {
  const f = created(), base = {...f.run.evidenceSources[1], media: null};
  f.state.imports[0].pageCount = 390;
  f.run.evidenceSources = Array.from({length: 390}, (_, i) => ({...base, sourceId: 'source-' + i, page: i + 1,
    excerptState: i < 184 ? 'retained' : 'omitted', excerptCharacters: 2048, textRepresentation: 'normalized-page', excerpt: i < 184 ? 'DO_NOT_COPY_REQUEST_TEXT' : null}));
  f.run.evidenceSources.push(...f.run.evidenceSources.map(value => ({...value})));
  f.run.evidenceExcerptLimitReached = true;
  f.note.provenance = P.capture(f.state, f.run, {type: 'note', id: f.note.id, record: f.note});
  assert.equal(f.note.provenance.inputs.length, 390);
  assert.equal(f.note.provenance.inputs.at(-1).sourceId, 'source-389');
  assert.equal(f.note.provenance.inputs.at(-1).page, 390);
  assert.equal(f.note.provenance.inputs.at(-1).excerptState, 'omitted');
  assert.equal(f.note.provenance.inputs.at(-1).excerptCharacters, 2048);
  assert.equal(f.note.provenance.inputs.at(-1).textRepresentation, 'normalized-page');
  assert.equal(f.note.provenance.omittedInputs, 0);
  assert.equal(f.note.provenance.evidenceExcerptLimitReached, true);
  assert.equal(f.note.provenance.evidenceLimitReached, false);
  assert.doesNotMatch(JSON.stringify(f.note.provenance), /DO_NOT_COPY|Real request-time|excerpt":/);
  const restarted = sortedRoundtrip(f.state); restarted.agentRuns = [];
  const view = P.project(restarted, {type: 'note', id: f.note.id});
  assert.equal(view.inputs.length, 390); assert.equal(view.inputs.at(-1).page, 390);
  assert.equal(view.inputs[0].status, 'current');
  assert.equal(view.inputs.at(-1).status, 'unretained');
  assert.equal(view.inputs.at(-1).available, true);
  assert.equal(view.inputs.at(-1).excerptState, 'omitted');
  assert.match(view.inputs.at(-1).detail, /不能还原或核对旧摘录/);
  assert.match(view.inputs.at(-1).detail, /不代表结论已经核验/);
  assert.equal(view.evidenceExcerptLimitReached, true); assert.equal(view.omittedInputs, 0);
  assert.equal(view.origin.runAvailable, false);
});

test('omitted excerpt receipts never hydrate current text and retain privacy and source lifecycle checks', () => {
  for (const mutate of [() => {}, s => s.notes[0].content = 'SECRET_CURRENT_REPLACEMENT',
    s => s.notes[0].private = true, s => s.notes[0].archived = true, s => s.notes[0].deletedAt = 2,
    s => s.notes.push({...s.notes[0]}), s => s.notes.splice(0, 1)]) {
    const f = created();
    Object.assign(f.run.evidenceSources[0], {excerpt: null, excerptState: 'omitted', excerptCharacters: 65000});
    f.note.provenance = P.capture(f.state, f.run, {type: 'note', id: f.note.id, record: f.note});
    mutate(f.state);
    const row = project(f).inputs[0];
    assert.equal(row.status, row.available ? 'unretained' : 'unavailable');
    assert.doesNotMatch(JSON.stringify(row), /SECRET_CURRENT_REPLACEMENT|Real request-time/);
    assert.equal(Object.hasOwn(row, 'excerpt'), false);
    if (row.available) {
      assert.equal(row.excerptCharacters, 65000);
      assert.match(row.detail, /未留存当时片段/);
    } else {
      assert.equal(row.page, null); assert.equal(row.offset, null);
      assert.equal(Object.hasOwn(row, 'excerptCharacters'), false);
      assert.equal(Object.hasOwn(row, 'excerptState'), false);
    }
  }
});

test('excerpt receipt metadata remains an exact typed scalar allowlist without promoting unknown states', () => {
  const f = created();
  Object.assign(f.run.evidenceSources[0], {excerptState: 'invented', excerptCharacters: -1, textRepresentation: 'invented', body: 'SECRET_BODY'});
  f.note.provenance = P.capture(f.state, f.run, {type: 'note', id: f.note.id, record: f.note});
  const saved = f.note.provenance.inputs[0];
  for (const field of ['excerptState', 'excerptCharacters', 'textRepresentation', 'excerpt', 'body']) assert.equal(Object.hasOwn(saved, field), false);
  assert.equal(project(f).inputs[0].status, 'current');
});

test('historical omitted input counts remain visible without reconstructing them from current attachments', () => {
  const f = created();
  f.note.provenance.omittedInputs = 56; f.note.provenance.evidenceLimitReached = true;
  const view = project(f);
  assert.equal(view.inputs.length, 2); assert.equal(view.omittedInputs, 56);
  assert.equal(view.evidenceLimitReached, true);
  assert.equal(view.evidenceExcerptLimitReached, false);
});

test('local references remain non-navigable without claiming current bytes', () => {
  const f = created();
  f.state.projects[0].localFolder = {id: 'folder'};
  f.run.evidenceSources = []; f.run.fileReferences = [{type: 'local', projectId: 'project', candidateId: 'folder', path: 'src/file.js', title: 'File', readAt: 2, version: 'snapshot-v1'}];
  f.note.provenance = P.capture(f.state, f.run, {type: 'note', id: f.note.id, record: f.note});
  const local = project(f).inputs[0]; assert.equal(local.type, 'local'); assert.equal(local.available, false); assert.equal(local.status, 'unrecorded'); assert.match(local.detail, /暂不支持/);
});

test('actual private Core output remains private across the real restart purge in every reading projection', () => {
  const f = fixture(); f.state.conversations[0].ephemeral = true;
  const state = Core.applyPlan(f.state, [noteAction], f.context()).state;
  const note = state.notes.find(value => value.title === noteAction.title), ref = {type: 'note', id: note.id};
  assert.equal(note.provenance.origin.private, true, 'the host/Core captures durable privacy at creation');
  assert.equal(Evidence.access(state, ref).kind, 'private');
  PrivateMode.init({getState: () => state, save() {}});
  assert.equal(state.conversations.length, 0); assert.equal(state.agentRuns.length, 0);
  assert.equal(state.notes.includes(note), true, 'the actual purge retains the generated knowledge object');
  assert.equal(Evidence.access(state, ref).kind, 'private');
  assert.equal(P.access(state, ref).private, true); assert.equal(P.project(state, ref).available, false);
  const catalog = Catalog.build({state, projectId: 'project', scope: 'all'});
  assert.equal(catalog.items.some(item => item.id === note.id), false);
  assert.doesNotMatch(JSON.stringify(catalog), /Research summary/);
});

test('privacy follows both trash run formats and retained provenance without reviving deleted sources', () => {
  for (const collection of ['runs', 'agentRuns']) {
    const f = created();
    delete f.note.agentRunId; delete f.note.sourceConversationId;
    f.state.trash = [{data: {[collection]: [{...f.run, private: true}], conversations: [f.state.conversations[0]]}}];
    f.state.agentRuns = []; f.state.conversations = [];
    const ref = {type: 'note', id: f.note.id};
    assert.equal(Evidence.access(f.state, ref).kind, 'private', collection);
    assert.equal(P.access(f.state, ref).private, true, collection);
    assert.equal(P.project(f.state, ref).available, false, collection);
    assert.equal(Catalog.build({state: f.state, projectId: 'project', scope: 'all'}).items.some(item => item.id === f.note.id), false, collection);
  }
});

test('public retained Core outputs stay readable after source archive, deletion or trash removal', () => {
  for (const retire of [
    f => { f.state.conversations[0].archived = true; },
    f => { f.state.trash.push({data: {runs: f.state.agentRuns, conversations: f.state.conversations}}); f.state.agentRuns = []; f.state.conversations = []; },
    f => { f.state.agentRuns = []; f.state.conversations = []; f.state.trash = []; }
  ]) {
    const f = created(); retire(f); const ref = {type: 'note', id: f.note.id};
    assert.equal(Evidence.access(f.state, ref).available, true);
    assert.equal(P.access(f.state, ref).available, true);
    const projected = P.project(f.state, ref);
    assert.equal(projected.available, true); assert.equal(projected.origin.conversationAvailable, false); assert.equal(projected.origin.runAvailable, false);
    const row = Catalog.build({state: f.state, projectId: 'project', scope: 'all'}).items.find(item => item.id === f.note.id);
    assert.equal(row.available, true); assert.deepEqual(row.open, {kind: 'note', id: f.note.id});
  }
});

test('private deleted source itself is redacted without treating its trash record as live', () => {
  const f = created(), source = f.state.notes.shift(); source.private = true;
  f.state.trash.push({data: {notes: [source]}});
  assert.equal(Evidence.access(f.state, {type: 'note', id: source.id}).kind, 'private');
  const input = P.project(f.state, {type: 'note', id: f.note.id}).inputs.find(value => value.id === source.id);
  assert.equal(input.available, false); assert.equal(input.title, '私密来源');
});
