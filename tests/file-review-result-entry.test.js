const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/file-review'), 'utf8');
const CitationEvidence = require('../app/citation-evidence'), DraftReview = require('../app/draft-review');

function fixture() {
  const note = { id: 'n', title: 'Result', content: 'Saved body', projectId: 'p' };
  const change = { type: 'note', id: 'n', title: 'Result', operation: 'created', added: 0, removed: 0, before: null, after: { ...note } };
  const run = { id: 'r', conversationId: 'c', status: 'completed', executionReceipt: { version: 1, phase: 'committed' }, fileChanges: [change] };
  const conversation = { id: 'c', messages: [] }, state = { notes: [note], imports: [], projects: [{ id: 'p' }], agentRuns: [run], conversations: [conversation] };
  const calls = [], cards = [];
  const context = { CitationEvidence, DraftReview, document: { createElement: () => ({ children: [], append(...nodes) { this.children.push(...nodes); } }) },
    HalaskaUI: { componentNames: ['ReviewChangeCard'], mount(host, name, props) { cards.push({ host, name, props }); } } };
  vm.createContext(context); vm.runInContext(source, context);
  const hooks = { getState: () => state, open: (...args) => calls.push(['review', ...args]), openFile: (...args) => calls.push(['open', ...args]) };
  context.FileReview.init(hooks);
  return { state, note, change, run, conversation, hooks, calls, cards, render() { const previous=cards.length;context.FileReview.card(run, state); return cards.length>previous?cards.at(-1).props:null; } };
}

test('saved result has a direct document entry and a separate unchanged historical review callback', () => {
  const h = fixture(), props = h.render(), anchor = {};
  assert.equal(props.changes[0].canOpen, true); assert.equal(props.changes[0].openLabel, '打开文档');
  props.onSelect('n', anchor);
  assert.equal(h.calls[0][0], 'open'); assert.equal(h.calls[0][1], 'note'); assert.equal(h.calls[0][2], 'n');
  const options = h.calls[0][3]; assert.equal(options.anchor, anchor); assert.equal(options.sourceGuard.runId, 'r'); assert.equal(options.sourceGuard.conversationId, 'c'); assert.equal(options.canOpen(), true);
  props.onReview('n'); assert.deepEqual(h.calls[1], ['review', 'r', 'n']);
  assert.equal(h.change.after.content, 'Saved body');
});

test('pending proposals, undo, retired public records and uncommitted saves retain review-only entries', () => {
  for (const mutate of [
    h => { h.change.operation = 'drafted'; h.note.aiDraft = { content: 'Draft', createdAt: 1 }; h.change.after.aiDraft = { ...h.note.aiDraft }; },
    h => { h.change.undoneAt = 1; }, h => { h.state.notes = []; }, h => { h.note.deletedAt = 1; },
    h => { h.state.projects[0].archived = true; },
    h => { h.run.executionReceipt.phase = 'applied'; }, h => { h.run.executionReceipt.version = 2; }, h => { h.run.approvalReceipt = { savePending: true }; },
  ]) {
    const h = fixture(); mutate(h); const props = h.render();
    assert.equal(props.changes[0].canOpen, false); props.onSelect('n');
    assert.deepEqual(h.calls, [['review', 'r', 'n']]);
  }
});

test('direct-entry callbacks revalidate the current run, proposal and record rather than captured presentation', () => {
  for (const mutate of [h => { h.state.agentRuns = [{ ...h.run }]; }, h => { h.note.aiDraft = { content: 'New draft' }; }, h => { h.note.private = true; }]) {
    const h = fixture(), props = h.render(); mutate(h); props.onSelect('n');
    assert.deepEqual(h.calls,h.note.aiDraft?[['review','r','n']]:[]);
  }
});

test('private or ambiguous results are absent rather than exposed as review-only cards',()=>{
 for(const mutate of [h=>{h.conversation.private=true;},h=>{h.note.private=true;},h=>{h.state.projects[0].private=true;},h=>{h.state.notes.push({...h.note});},h=>{h.run.fileChanges.push({...h.change,type:'import'});}]){
  const h=fixture();mutate(h);assert.equal(h.render(),null);assert.deepEqual(h.calls,[]);
 }
});

test('reader guard rejects an origin changed while waiting for the editor leave decision', async () => {
  for (const mutate of [h => { h.run.deletedAt = 1; }, h => { h.conversation.private = true; }, h => { h.note.deletedAt = 1; }, h => { h.note.aiDraft = { content: 'New draft' }; }, h => { h.state.notes = [{ ...h.note }]; }, h => { h.state.conversations.push({ id: 'other' }); h.run.conversationId = 'other'; }]) {
    const h = fixture(); let release;
    const leave = new Promise(resolve => { release = resolve; });
    h.hooks.openFile = async (_type, _id, options) => { await leave; return options.canOpen(); };
    const props = h.render(), pending = props.onSelect('n'); mutate(h); release();
    assert.equal(await pending, false);
  }
});

test('saved imports use the source entry, while unknown records and save-pending rows make no saved claim', () => {
  const h = fixture(); h.change.type = 'import'; h.state.imports = [h.note]; h.state.notes = [];
  let props = h.render(); assert.equal(props.changes[0].openLabel, '打开资料'); props.onSelect('n'); assert.equal(h.calls[0][1], 'import');
  h.run.executionReceipt.phase = 'applied'; props = h.render(); assert.equal(props.changes[0].status, '等待保存'); assert.equal(props.changes[0].canOpen, false);
  h.run.executionReceipt.phase = 'committed'; h.run.status = 'unknown'; props = h.render(); assert.equal(props.changes[0].status, '历史变更'); assert.equal(props.changes[0].canOpen, false);
});
