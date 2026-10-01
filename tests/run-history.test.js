const test = require('node:test');
const assert = require('node:assert/strict');
const History = require('../app/run-history.js');
const fixture = () => ({
  projects: [{ id: 'p', name: '控制理论' }],
  conversations: [{ id: 'live', title: '当前论文', projectId: 'p' }, { id: 'archived', title: '旧课程', archived: true }, { id: 'deleted', deletedAt: 5 }],
  agentRuns: [
    { id: 'r1', goal: '分析控制论文', conversationId: 'live', status: 'completed', startedAt: 10, finishedAt: 20, modelConfig: { provider: 'openai-auth', model: 'actual-model', effort: 'high' }, steps: [{ text: '解析原文', status: 'done' }], results: [{ type: 'note', text: '写入论文摘要' }] },
    { id: 'r2', goal: '读取课程讲义', conversationId: 'archived', status: 'failed', startedAt: 30, error: '课程文件未找到' },
    { id: 'r3', goal: '本地整理控制材料', conversationId: 'live', status: 'completed-local', startedAt: 25 },
    { id: 'r4', goal: 'legacy missing conversation', conversationId: 'missing', status: 'cancelled', startedAt: 4 },
    { id: 'trash-copy', goal: '已删除运行', conversationId: 'live', status: 'completed', startedAt: 100 },
    { id: 'deleted-conversation', goal: '不应显示', conversationId: 'deleted', status: 'completed', startedAt: 101 },
    { id: 'trashed-conversation', goal: '也不应显示', conversationId: 'in-trash', status: 'completed', startedAt: 102 }
  ],
  trash: [{ data: { runs: [{ id: 'trash-copy' }] } }, { data: { conversations: [{ id: 'in-trash' }] } }]
});
const frozen = value => { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; };

test('history includes archived conversations, excludes trash and sorts without modifying state', () => {
  const state = frozen(fixture()); const before = JSON.stringify(state);
  assert.deepEqual(History.queryRuns(state).map(run => run.id), ['r2', 'r3', 'r1', 'r4']);
  assert.equal(JSON.stringify(state), before);
});

test('search and status filters combine, with completed local runs in the completed group', () => {
  const state = fixture();
  assert.deepEqual(History.queryRuns(state, { query: '控制', status: 'completed' }).map(run => run.id), ['r3', 'r1']);
  assert.deepEqual(History.queryRuns(state, { query: '课程', status: 'failed' }).map(run => run.id), ['r2']);
  assert.equal(History.queryRuns(state, { query: 'missing', status: 'failed' }).length, 0);
  state.agentRuns.push({id:'iso',goal:'UPPER goal',status:'running',startedAt:'2026-09-11T00:00:00Z'});
  assert.equal(History.queryRuns(state, {query:'upper'})[0].id, 'iso');
});

test('archived, deleted and missing originals never resolve to another active conversation', () => {
  const state = fixture();
  assert.equal(History.conversationFor(state, state.agentRuns[0]).conversation.id, 'live');
  assert.equal(History.conversationFor(state, state.agentRuns[1]).active, false);
  assert.equal(History.conversationFor(state, state.agentRuns[3]).conversation, null);
  state.projects[0].archived = true;
  assert.equal(History.conversationFor(state, state.agentRuns[0]).active, false);
});

function harness(state = fixture(), options = {}) {
  const elements = [];
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.value = ''; this.open = false; this.textContent = ''; elements.push(this); }
    set innerHTML(_) { throw new Error('History must not interpret stored content as HTML'); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(type, action) { (this.listeners[type] ||= []).push(action); }
    async fire(type, fields = {}) { const event = {target:this,...fields}; for(const action of this.listeners[type] || []) await action(event); }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; void this.fire('close'); }
  }
  const document = { body: new Element('body'), createElement: tag => new Element(tag) };
  const opener = new Element('button'); opener.id = 'historyBtn'; document.activeElement = opener;
  const opened = [], toasts = [], saves = [], renders = [];
  const api = History.createController({ getState: () => state, openConversation: id => opened.push(id), toast: message => toasts.push(message), save: () => { saves.push(JSON.stringify(state)); return options.save?.(state); }, renderAll: () => renders.push(true), openResult: options.openResult }, { document, ...options.environment });
  api.open();
  const el = id => elements.find(item => item.id === id);
  const flatten = node => [node, ...node.children.flatMap(flatten)];
  const active = () => flatten(document.body);
  const select = id => active().find(node => node.dataset.runId === id).fire('click');
  return {api,state,elements,document,opener,opened,toasts,saves,renders,el,active,select, confirm: () => el('runHistoryDeleteDialog').children[0].fire('submit', {preventDefault(){}}), content:()=>active().map(node=>node.textContent).filter(Boolean).join('\n')};
}

test('opening, filtering and viewing steps/results are read-only, with literal untrusted text', async () => {
  const state = fixture();
  state.agentRuns[0].goal = '<img src=x onerror=alert(1)>';
  state.agentRuns[0].steps[0].text = '<script>danger()</script>';
  state.agentRuns[0].results[0].text = '& <b>saved</b>';
  const before = JSON.stringify(state); const h = harness(frozen(state));
  await h.select('r1');
  assert.match(h.content(), /<img src=x onerror=alert\(1\)>/);
  assert.match(h.content(), /<script>danger\(\)<\/script>/);
  assert.match(h.content(), /& <b>saved<\/b>/);
  assert.match(h.content(), /actual-model/); assert.match(h.content(), /high/);
  h.el('runHistorySearch').value = '课程'; await h.el('runHistorySearch').fire('input');
  assert.equal(h.active().filter(node=>node.dataset.runId).length,1);
  h.el('runHistoryStatus').value = 'completed'; await h.el('runHistoryStatus').fire('change');
  assert.match(h.content(), /没有匹配记录/); assert.equal(JSON.stringify(state),before);
});

test('active original opens the exact conversation after closing; archived originals remain historical', async () => {
  const h = harness(); await h.select('r1'); assert.equal(h.api.openOriginal(),true);
  assert.deepEqual(h.opened,['live']); assert.equal(h.el('runHistoryDialog').open,false);
  assert.equal(h.document.activeElement,h.opener);
  h.api.open(); await h.select('r2');
  assert.match(h.content(),/原对话已归档/); assert.match(h.content(),/课程文件未找到/);
  assert.equal(h.api.openOriginal(),false); assert.deepEqual(h.opened,['live']);
});

test('the original is revalidated if archived or deleted while history is open', async () => {
  const h = harness(); await h.select('r1'); h.state.conversations[0].archived = true;
  assert.equal(h.api.openOriginal(),false); assert.deepEqual(h.opened,[]);
  h.state.agentRuns = h.state.agentRuns.filter(run=>run.id!=='r1');
  assert.equal(h.api.openOriginal(),false); assert.deepEqual(h.opened,[]);
});

test('large history remains accessible in chunks and Escape-style close returns focus without writes', async () => {
  const state = fixture(); state.agentRuns = Array.from({length:95},(_,index)=>({id:`r${index}`,goal:`记录${index}`,conversationId:'live',status:'completed',startedAt:index+1}));
  const before = JSON.stringify(state); const h = harness(frozen(state));
  assert.equal(h.active().filter(node=>node.dataset.runId).length,80);
  await h.active().find(node=>node.textContent==='再显示 15 条').fire('click');
  assert.equal(h.active().filter(node=>node.dataset.runId).length,95);
  // A native HTML dialog closes on Escape; this exercises the same close event.
  h.el('runHistoryDialog').close(); assert.equal(h.document.activeElement,h.opener);
  assert.equal(JSON.stringify(state),before);
});

test('an empty store has a helpful empty state and no invented history', () => {
  const h = harness(frozen({agentRuns:[],conversations:[],projects:[],trash:[]}));
  assert.match(h.content(),/还没有执行记录/); assert.equal(h.active().filter(node=>node.dataset.runId).length,0);
});

test('legacy null entries and invalid timestamps do not break a readable history', async () => {
  const state = fixture(); state.agentRuns.push(null); state.conversations.push(null); state.projects.push(null); state.trash.push(null,{data:{runs:[null],conversations:[null]}});
  state.agentRuns[0].steps.push(null); state.agentRuns[0].results.push(null); state.agentRuns[0].finishedAt=1e40;
  const h = harness(frozen(state)); await h.select('r1');
  assert.match(h.content(),/未记录/); assert.match(h.content(),/执行结果 · 1 项/);
  assert.equal(History.statusLabel('__proto__'),'状态：__proto__');
});

test('only recognized terminal runs are deletable; missing and duplicate identities reject atomically', () => {
  for (const status of ['completed','completed-local','completed-local-fallback','failed','cancelled','rejected','interrupted']) assert.equal(History.canDeleteRun({id:'a',status}),true);
  for (const status of ['running','awaiting-approval','queued','',null,'__proto__']) assert.equal(History.canDeleteRun({id:'a',status}),false);
  const state=fixture(); state.agentRuns.push({id:'busy',status:'running',conversationId:'live'});
  assert.throws(()=>History.deletionPlan(state,['r1','busy']),/不能删除/);
  assert.throws(()=>History.deletionPlan(state,['r1','missing']),/不再可用/);
  state.agentRuns.push({...state.agentRuns[0]});
  assert.throws(()=>History.deletionPlan(state,['r1']),/记录已变化/);
});

test('single-log deletion requires explicit confirmation; cancellation does not change anything', async () => {
  const h=harness(), before=JSON.stringify(h.state); await h.select('r1');
  await h.el('runHistoryDeleteOne').fire('click');
  assert.equal(h.el('runHistoryDeleteDialog').open,true);
  assert.equal(h.document.activeElement,h.el('runHistoryDeleteCancel'));
  assert.match(h.content(),/永久删除 1 条执行日志/); assert.match(h.content(),/无法恢复/); assert.match(h.content(),/聊天消息、任务、笔记、项目与资料全部保留/);
  await h.el('runHistoryDeleteCancel').fire('click');
  assert.equal(h.el('runHistoryDeleteDialog').open,false); assert.equal(JSON.stringify(h.state),before); assert.equal(h.saves.length,0);
});

test('confirmed deletion removes only the selected local log and never writes to cloud trash or content', async () => {
  const state=fixture(); state.tasks=[{id:'task',status:'done',runId:'r1'}]; state.notes=[{id:'note',content:'keep',runId:'r1'}]; state.imports=[{id:'file',name:'original.pdf'}];
  state.conversations[0].messages=[{id:'message',text:'keep response',runId:'r1',results:[{type:'note',id:'note'}]}];
  const other=JSON.stringify({...state,agentRuns:undefined}), h=harness(state); await h.select('r1'); await h.el('runHistoryDeleteOne').fire('click'); await h.confirm();
  assert.equal(state.agentRuns.some(run=>run.id==='r1'),false); assert.equal(state.agentRuns.length,6);
  assert.equal(JSON.stringify({...state,agentRuns:undefined}),other); assert.equal(h.saves.length,1); assert.equal(h.renders.length,1);
  assert.equal(h.el('runHistoryDeleteDialog').open,false); assert.match(h.toasts.at(-1),/对话与成果均保留/);
});

test('filtered select-all includes unloaded matching runs, excludes running and awaiting approval, and clears hidden selection', async () => {
  const state=fixture(); state.agentRuns=Array.from({length:96},(_,index)=>({id:`end${index}`,goal:`论文 ${index}`,status:'completed',conversationId:'live',startedAt:index+1}));
  state.agentRuns.push({id:'busy',goal:'论文 working',status:'running',conversationId:'live'},{id:'approval',goal:'论文 approval',status:'awaiting-approval',conversationId:'live'},{id:'other',goal:'课程',status:'failed',conversationId:'live'});
  const h=harness(state); h.el('runHistorySearch').value='论文'; await h.el('runHistorySearch').fire('input');
  assert.equal(h.active().filter(node=>node.dataset.runId).length,80);
  h.el('runHistorySelectAll').checked=true; await h.el('runHistorySelectAll').fire('change');
  assert.match(h.el('runHistoryDeleteSelected').textContent,/96/);
  await h.el('runHistoryDeleteSelected').fire('click'); await h.confirm();
  assert.deepEqual(state.agentRuns.map(run=>run.id),['busy','approval','other']);
  h.el('runHistorySearch').value=''; await h.el('runHistorySearch').fire('input');
  assert.equal(h.active().find(node=>node.dataset.selectRun==='busy').disabled,true);
  assert.equal(h.active().find(node=>node.dataset.selectRun==='approval').disabled,true);
  h.el('runHistorySelectAll').checked=true; await h.el('runHistorySelectAll').fire('change');
  h.el('runHistorySearch').value='论文'; await h.el('runHistorySearch').fire('input');
  assert.equal(h.el('runHistoryDeleteSelected').disabled,true);
});

test('checkbox selection supports partial state, unchecking and cancel-all without writes', async () => {
  const h=harness(); let check=h.active().find(node=>node.dataset.selectRun==='r1'); check.checked=true; await check.fire('change');
  assert.equal(h.el('runHistorySelectAll').indeterminate,true); assert.match(h.el('runHistoryDeleteSelected').textContent,/1/);
  check=h.active().find(node=>node.dataset.selectRun==='r1'); check.checked=false; await check.fire('change');
  assert.equal(h.el('runHistoryDeleteSelected').disabled,true);
  h.el('runHistorySelectAll').checked=true; await h.el('runHistorySelectAll').fire('change');
  assert.equal(h.el('runHistorySelectAll').checked,true);
  await h.el('runHistoryClearSelection').fire('click'); assert.equal(h.el('runHistorySelectAll').checked,false); assert.equal(h.saves.length,0);
});

test('if a selected run becomes active or changes while confirmation is open, the whole batch is retained', async () => {
  for (const change of [run=>run.status='running',run=>run.status='awaiting-approval',run=>run.goal='changed',run=>run.results=[{id:'new'}]]) {
    const h=harness(); h.el('runHistorySelectAll').checked=true; await h.el('runHistorySelectAll').fire('change'); await h.el('runHistoryDeleteSelected').fire('click');
    change(h.state.agentRuns[0]); const before=JSON.stringify(h.state); await h.confirm();
    assert.equal(h.saves.length,0); assert.equal(JSON.stringify(h.state),before); assert.equal(h.el('runHistoryDeleteConfirm').disabled,true);
    assert.match(h.el('runHistoryDeleteStatus').textContent,/不能删除|已有更新/);
  }
});

test('saving disables duplicate confirmation and Escape; failure restores logs while preserving newly appended runs', async () => {
  let reject; const pending=new Promise((_,no)=>reject=no), h=harness(fixture(),{save:()=>pending});
  await h.select('r1'); await h.el('runHistoryDeleteOne').fire('click'); const saving=h.confirm();
  assert.equal(h.state.agentRuns.some(run=>run.id==='r1'),false); assert.equal(h.el('runHistoryDeleteCancel').disabled,true);
  await h.confirm(); assert.equal(h.saves.length,1);
  let prevented=false; await h.el('runHistoryDeleteDialog').fire('cancel',{preventDefault(){prevented=true;}}); assert.equal(prevented,true);
  h.api.close(); assert.equal(h.el('runHistoryDialog').open,true);
  h.state.agentRuns.push({id:'new',status:'running',conversationId:'live'}); reject(new Error('磁盘已满')); await saving;
  assert.equal(h.state.agentRuns.some(run=>run.id==='r1'),true); assert.equal(h.state.agentRuns.some(run=>run.id==='new'),true);
  assert.match(h.el('runHistoryDeleteStatus').textContent,/日志已保留.*磁盘已满/); assert.equal(h.el('runHistoryDeleteDialog').open,true); assert.equal(h.renders.length,0);
});

test('save failure never resurrects logs removed by a separate conversation-deletion transaction', async () => {
  let reject; const pending=new Promise((_,no)=>reject=no), h=harness(fixture(),{save:()=>pending});
  await h.select('r1'); await h.el('runHistoryDeleteOne').fire('click'); const saving=h.confirm();
  h.state.agentRuns=h.state.agentRuns.filter(run=>run.conversationId!=='live');
  h.state.conversations=h.state.conversations.filter(item=>item.id!=='live');
  const latest=JSON.stringify(h.state); reject(new Error('failed')); await saving;
  assert.equal(JSON.stringify(h.state),latest); assert.match(h.el('runHistoryDeleteStatus').textContent,/工作区已有其他变更/);
});

test('an explicit false save result retains the record and selection for retry', async () => {
  let success=false; const h=harness(fixture(),{save:()=>success});
  const checkbox=h.active().find(node=>node.dataset.selectRun==='r1'); checkbox.checked=true; await checkbox.fire('change');
  await h.el('runHistoryDeleteSelected').fire('click'); await h.confirm();
  assert.equal(h.state.agentRuns.some(run=>run.id==='r1'),true); assert.match(h.el('runHistoryDeleteSelected').textContent,/1/);
  success=true; await h.confirm(); assert.equal(h.state.agentRuns.some(run=>run.id==='r1'),false); assert.equal(h.saves.length,2);
});

const Core = require('../app/workstation-core.js');
const Outcomes = require('../app/run-outcome-presentation.js');
const Notes = require('../app/note-consolidation.js');
const Evidence = require('../app/citation-evidence.js');
const presentationEnvironment = { WorkstationCore: Core, RunOutcomePresentation: Outcomes, AgentTransport: { inspectProtocolOutput: text => text.includes('DSML') ? { code: 'MODEL_PROTOCOL_ERROR' } : null } };
test('history filters and labels use the same read-only historical correction as chat', () => {
  const state = fixture(), run = state.agentRuns[0]; run.results = []; run.validationErrors = ['old failure'];
  state.conversations[0].messages = [{role:'assistant',runId:run.id,text:'已完成整理。'}];
  const before = JSON.stringify(state), shown = History.presentation(state,run,presentationEnvironment);
  assert.equal(shown.status,'failed'); assert.match(shown.error,/没有交付整理结果/);
  assert.equal(History.queryRuns(state,{status:'completed'},presentationEnvironment).some(item=>item.id===run.id),false);
  assert.equal(History.queryRuns(state,{status:'failed'},presentationEnvironment).some(item=>item.id===run.id),true);
  assert.equal(JSON.stringify(state),before); assert.equal(run.status,'completed');
  state.conversations[0].messages[0].text='<DSML> calls'; run.validationErrors=[];
  assert.match(History.presentation(state,run,presentationEnvironment).error,/未执行的工具调用/);
  state.conversations[0].messages[0].text='实质性的最终结论';
  assert.equal(History.presentation(state,run,presentationEnvironment).status,'completed');
});
test('a pending durable receipt takes precedence over completed and cannot be permanently deleted', () => {
  const state=fixture(),run=state.agentRuns[0]; run.approvalReceipt={savePending:true,baseText:'等待写入'};
  assert.equal(History.presentation(state,run,presentationEnvironment).status,'awaiting-save');
  assert.equal(History.canDeleteRun(run),false); assert.throws(()=>History.deletionPlan(state,[run.id]),/不能删除/);
});
test('unconfirmed execution checkpoints override stale completion without suggesting a new model retry', () => {
  for (const phase of ['prepared','applied']) {
    const state=fixture(),run=state.agentRuns[0]; run.results=[];
    run.executionReceipt={version:1,id:'receipt',phase,error:'保存确认丢失',actionCount:2};
    state.conversations[0].messages=[{role:'assistant',runId:run.id,text:'已完成整理。'}];
    const before=JSON.stringify(state),shown=History.presentation(state,run,presentationEnvironment);
    assert.equal(shown.status,phase==='prepared'?'interrupted':'awaiting-save');assert.equal(shown.tone,'pending');
    assert.match(shown.label,phase==='prepared'?/可继续整理/:/等待保存确认/);
    assert.match(shown.hint,phase==='prepared'?/重新校验计划与当前权限/:/不会重新调用模型或再次执行/);
    assert.equal(shown.error,'保存确认丢失');assert.equal(shown.historicalIssue,false);
    assert.equal(History.queryRuns(state,{status:'completed'},presentationEnvironment).some(item=>item.id===run.id),false);
    assert.equal(JSON.stringify(state),before);
  }
});
test('prepared and applied receipts cannot be deleted even when cached run status is terminal', () => {
  for (const phase of ['prepared','applied']) for (const status of ['interrupted','failed','cancelled','completed']) {
    const state=fixture(),run=state.agentRuns[0];run.status=status;run.executionReceipt={version:1,phase};
    assert.equal(History.canDeleteRun(run),false,`${phase}/${status}`);
    assert.throws(()=>History.deletionPlan(state,[run.id]),/不能删除/);
  }
  const state=fixture(),run=state.agentRuns[0];run.executionReceipt={version:1,phase:'committed'};
  assert.equal(History.canDeleteRun(run),true,'acknowledged terminal records retain their existing deletion policy');
});
test('a preparation checkpoint in the current active execution remains running rather than falsely interrupted', () => {
  const state=fixture(),run=state.agentRuns[0];run.status='running';run.executionReceipt={version:1,phase:'prepared'};
  const shown=History.presentation(state,run,presentationEnvironment);assert.equal(shown.status,'running');assert.equal(shown.tone,'accent');assert.match(shown.label,/执行中/);assert.doesNotMatch(shown.hint,/继续整理/);
  assert.equal(History.queryRuns(state,{status:'running'},presentationEnvironment)[0].id,run.id);assert.equal(History.canDeleteRun(run),false);
});
test('checkpoint transferred to approval keeps approval priority and its pending-save protection', () => {
  const state=fixture(),run=state.agentRuns[0];run.status='awaiting-approval';run.executionReceipt={version:1,phase:'prepared'};
  let shown=History.presentation(state,run,presentationEnvironment);assert.equal(shown.status,'awaiting-approval');assert.match(shown.hint,/审阅并批准/);assert.equal(History.canDeleteRun(run),false);
  run.approvalReceipt={savePending:true,baseText:'批准后的保存尚未确认'};run.status='completed';run.executionReceipt.phase='applied';
  shown=History.presentation(state,run,presentationEnvironment);assert.equal(shown.status,'awaiting-save');assert.equal(History.canDeleteRun(run),false);
});
test('history detail exposes the recoverable phase and its original conversation without enabling deletion', async () => {
  const state=fixture(),run=state.agentRuns[0];run.status='interrupted';run.executionReceipt={version:1,phase:'prepared'};
  const h=harness(state);await h.select(run.id);
  assert.match(h.content(),/计划已保留 · 可继续整理/);assert.match(h.content(),/恢复方式/);assert.match(h.content(),/重新校验计划与当前权限/);
  assert.equal(h.el('runHistoryDeleteOne').disabled,true);assert.equal(h.api.openOriginal(),true);assert.deepEqual(h.opened,['live']);
});
test('results resolve only exact currently active typed entities and their current owner', () => {
  const state=fixture(); state.notes=[{id:'n',title:'当前标题',projectId:'p'}];
  const result={type:'note',id:'n',text:'历史名称',projectId:'gone'};
  assert.equal(History.resultFor(state,result).title,'当前标题'); assert.equal(History.resultFor(state,result).available,true);
  for (const patch of [{archived:true},{archivedAt:2},{deleted:true},{deletedAt:2},{status:'archived'},{status:'deleted'},{tombstone:true},{wikiFileError:'gone'}]) {
    const snapshot={...state,notes:[{...state.notes[0],...patch}]}; assert.equal(History.resultFor(snapshot,result).available,false,JSON.stringify(patch));
  }
  state.projects[0].archivedAt=3; assert.equal(History.resultFor(state,result).available,false);
  state.notes[0].projectId=null; assert.equal(History.resultFor(state,result).available,true,'moved out of former archived project');
  state.notes.push({...state.notes[0]}); assert.equal(History.resultFor(state,result).available,false);
  for (const invalid of [null,'historical text',{type:'__proto__',id:'n'},{type:'note'},{type:'paper',id:'n'}]) assert.equal(History.resultFor(state,invalid).available,false);
});
test('trash, canonical note aliases and transitive privacy preserve real result boundaries', () => {
  const state=fixture(); state.notes=[{id:'new',title:'已合并笔记',mergedNoteIds:['old'],projectId:'p'}];
  state.trash.push({data:{notes:[{id:'old'}]}});
  const environment={NoteConsolidation:Notes,CitationEvidence:Evidence};
  assert.equal(History.resultFor(state,{type:'note',id:'old'},environment).id,'new');
  assert.equal(History.resultFor(state,{type:'note',id:'old'},environment).available,true);
  state.projects[0].incognito=true; const hidden=History.resultFor(state,{type:'note',id:'old',text:'private previous title'},environment);
  assert.equal(hidden.available,false); assert.equal(hidden.title,'私密成果');
  delete state.projects[0].incognito; state.notes[0].sourceConversationId='secret'; state.conversations.push({id:'secret',ephemeral:true});
  assert.equal(History.resultFor(state,{type:'note',id:'new'},environment).available,false);
  state.conversations.pop(); state.trash.push({data:{notes:[{id:'new'}]}});
  assert.equal(History.resultFor(state,{type:'note',id:'new'},environment).available,false);
});
test('result click revalidates a stale target and dispatches exact identity after modal closes', async () => {
  const state=fixture();state.notes=[{id:'n',title:'笔记'}];state.agentRuns[0].results=[{type:'note',id:'n'}];
  let release,callCount=0; const pending=new Promise(resolve=>release=resolve);
  const h=harness(state,{openResult:async(type,id)=>{callCount++;assert.equal(type,'note');assert.equal(id,'n');assert.equal(h.el('runHistoryDialog').open,false);await pending;return false;}});
  await h.select('r1');state.notes[0].archived=true;assert.equal(await h.api.openResult(0),false);assert.equal(callCount,0);
  delete state.notes[0].archived; const opening=h.api.openResult(0);assert.equal(callCount,1);assert.equal(await h.api.openResult(0),false);release();assert.equal(await opening,false);assert.equal(callCount,1);assert.equal(h.saves.length,0);
});
test('unchanged refresh ticks retain a focused detail node and Escape stops the watcher', async()=>{
  let tick,stopped=0;const h=harness(fixture(),{environment:{setInterval:callback=>{tick=callback;return 99;},clearInterval:id=>{assert.equal(id,99);stopped++;}}});
  await h.select('r1');const node=h.active().find(item=>item.id==='runHistoryDeleteOne');node.focus();tick();
  assert.equal(h.active().find(item=>item.id==='runHistoryDeleteOne'),node);assert.equal(h.document.activeElement,node);
  h.el('runHistoryDialog').close();assert.equal(stopped,1);
});


test('opening a specific execution selects its detail immediately without changing records', () => {
  const h = harness(), before = JSON.stringify(h.state);
  h.api.open('r1');
  assert.equal(h.api.openOriginal(), true); assert.deepEqual(h.opened, ['live']);
  assert.equal(JSON.stringify(h.state), before); assert.equal(h.saves.length, 0);
});
