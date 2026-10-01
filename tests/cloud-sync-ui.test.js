const test = require('node:test');
const assert = require('node:assert/strict');
const Cloud = require('../app/cloud-sync-ui.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const connected = overrides => ({ connected: true, state: 'synced', serverUrl: 'https://sync.example.test', account: { username: 'researcher' }, device: { id: 'this-device', name: '我的电脑' }, autoSync: true, pending: 0, conflicts: 0, lastSyncAt: 1789000000000, remoteAppliedRevision: 0, ...overrides });

const conflictReply = entries => ({ ok: true, json: async () => ({ conflicts: entries }) });
const conflictSample = revision => ({id:'changing', revision, local:{content:'本机'},remote:{content:'服务器'}});

test('changed conflict requires explicit reload and never resubmits an unseen revision', async t => {
  const old='a'.repeat(64), next='b'.repeat(64); let revision=old;
  const h=harness({conflictKit:true,status:connected({conflicts:1}),fetch:call=>{
    if(call.url==='/__cloud/conflicts')return conflictReply([conflictSample(revision)]);
    if(call.url==='/__cloud/resolve')return {ok:false,status:409,json:async()=>({error:'changed',code:'CONFLICT_CHANGED'})};
  }});t.after(()=>h.api.destroy());await h.api.conflicts();
  const original=h.surfaces.CloudConflictReview;revision=next;
  await original.onChoose('changing','remote',old);
  assert.equal(h.surfaces.CloudConflictReview.error.staleId,'changing');
  assert.equal(h.surfaces.CloudConflictReview.entries[0].revision,old,'do not silently replace the version being reviewed');
  await original.onChoose('changing','remote',old);
  assert.equal(h.calls.filter(c=>c.url==='/__cloud/resolve').length,1,'stale choice cannot be retried');
  await h.surfaces.CloudConflictReview.onReload();
  assert.equal(h.surfaces.CloudConflictReview.entries[0].revision,next);
  await original.onChoose('changing','remote',old);
  assert.equal(h.calls.filter(c=>c.url==='/__cloud/resolve').length,1,'obsolete callback cannot resolve new content');
  await h.surfaces.CloudConflictReview.onChoose('changing','local',next);
  assert.equal(h.calls.filter(c=>c.url==='/__cloud/resolve').at(-1).body.revision,next);
});

test('missing revision and forged choice never reach the resolve endpoint',async t=>{
  const h=harness({conflictKit:true,fetch:c=>c.url==='/__cloud/conflicts'?conflictReply([conflictSample(undefined)]):null});t.after(()=>h.api.destroy());
  await h.api.conflicts();const ui=h.surfaces.CloudConflictReview;
  await ui.onChoose('changing','remote',undefined);await ui.onChoose('changing','both','a'.repeat(64));
  assert.equal(h.calls.some(c=>c.url==='/__cloud/resolve'),false);
});

test('closing review while the draft flush waits cancels the unsubmitted choice',async t=>{
  let release;const rev='d'.repeat(64);
  const h=harness({conflictKit:true,flush:()=>new Promise(r=>{release=r}),fetch:c=>c.url==='/__cloud/conflicts'?conflictReply([conflictSample(rev)]):null});t.after(()=>h.api.destroy());
  await h.api.conflicts();const choosing=h.surfaces.CloudConflictReview.onChoose('changing','local',rev);await tick();
  h.el('cloudSyncDialog').close();release(true);await choosing;
  assert.equal(h.calls.some(c=>c.url==='/__cloud/resolve'),false);assert.equal(h.surfaces.CloudConflictReview,undefined);
});

test('late conflict load cannot overwrite a newly opened review',async t=>{
  let release,count=0;const h=harness({conflictKit:true,fetch:c=>{
    if(c.url!='/__cloud/conflicts')return null;
    return ++count===1?new Promise(r=>{release=()=>r(conflictReply([conflictSample('a'.repeat(64))]))}):conflictReply([conflictSample('b'.repeat(64))]);
  }});t.after(()=>h.api.destroy());
  const old=h.api.conflicts();await tick();h.el('cloudSyncDialog').close();await h.api.conflicts();release();await old;
  assert.equal(h.surfaces.CloudConflictReview.entries[0].revision,'b'.repeat(64));
});

test('reload transport failure disables old snapshots without losing their displayed text',async t=>{
  let fail=false;const rev='c'.repeat(64);const h=harness({conflictKit:true,fetch:c=>{
    if(c.url!='/__cloud/conflicts')return null;if(fail)throw Error('offline');return conflictReply([conflictSample(rev)]);
  }});t.after(()=>h.api.destroy());await h.api.conflicts();fail=true;await h.surfaces.CloudConflictReview.onReload();
  assert.equal(h.surfaces.CloudConflictReview.error.staleId,'*');assert.match(h.surfaces.CloudConflictReview.entries[0].localPreview,/本机/);
  await h.surfaces.CloudConflictReview.onChoose('changing','remote',rev);assert.equal(h.calls.some(c=>c.url==='/__cloud/resolve'),false);
});

function harness(options = {}) {
  const elements = [], calls = [], applied = [], messages = []; let current = options.status || { connected: false, state: 'local' }, busy = false, flushes = 0;
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.value = ''; this.checked = false; this.hidden = false; elements.push(this); }
    set innerHTML(_) { throw new Error('HTML rendering is not permitted for cloud content'); }
    append(...children) { children.forEach(child => { child.parentNode = this; }); this.children.push(...children); }
    prepend(...children) { for (const child of children) { if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(item => item !== child); child.parentNode = this; } this.children.unshift(...children); }
    get parentElement() { return this.parentNode || null; }
    get firstElementChild() { return this.children[0] || null; }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    replaceWith(...children) { const parent = this.parentNode; const index = parent.children.indexOf(this); children.forEach(child => { child.parentNode = parent; }); parent.children.splice(index, 1, ...children); }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
    async fire(type) { const event = { preventDefault() {}, target: this }; for (const handler of this.listeners[type] || []) await handler(event); }
    querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
    focus() { doc.activeElement = this; }
    showModal() { options.onShowModal?.(doc.activeElement, this); this.open = true; }
    close() { this.open = false; void this.fire('close'); }
  }
  const host = new Element('section'), doc = { createElement: tag => new Element(tag), body: new Element('body'), visibilityState: 'visible', querySelector: selector => selector === '#settings .settings-grid' ? host : null, getElementById: id => elements.find(item => item.id === id) };
  doc.body.dataset.view = 'settings';
  const surfaces = {}, componentNames = [options.ssh && 'CloudSSHConnection', options.storage && 'CloudSSHStorage', options.overview && 'CloudSyncOverview', options.conflictKit && 'CloudConflictReview'].filter(Boolean);
  const environment = { ...(componentNames.length ? {HalaskaUI:{componentNames,mount:(host,name,props)=>{surfaces[name]=props;return {update:next=>{surfaces[name]=next},unmount:()=>{delete surfaces[name]}}}}} : {}), document: doc, disablePolling: true, get localStorage() { throw new Error('Cloud credentials must never enter localStorage'); } };
  const fetcher = async (url, init) => {
    const call = { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined }; calls.push(call);
    const result = await options.fetch?.(call); if (result) return result;
    if (url === '/__cloud/connect') current = connected();
    if (url === '/__cloud/disconnect') current = { connected: false, state: 'local', pending: 0, conflicts: 0, remoteAppliedRevision: 0 };
    if (url === '/__cloud/settings') current = { ...current, autoSync: call.body.autoSync };
    return { ok: true, json: async () => current };
  };
  const api = Cloud.createController({ fetch: fetcher, flush: async () => { flushes++; return options.flush?.() ?? true; }, applyRemote: async revision => { applied.push(revision); return options.applyRemote?.(revision) ?? true; }, getAppliedRevision: options.getAppliedRevision, isBusy: () => busy, toast: message => messages.push(message) }, environment);
  api.init();
  const el = id => elements.find(item => item.id === id);
  const fill = () => { el('cloudServerUrl').value = 'https://sync.example.test'; el('cloudUsername').value = 'researcher'; el('cloudPassword').value = 'top-secret-password'; el('cloudDeviceName').value = '我的 Mac'; el('cloudMergeConfirmed').checked = true; };
  return { api, doc, host, elements, calls, applied, messages, el, fill, surfaces, setStatus: value => { current = value; }, setBusy: value => { busy = value; }, get flushes() { return flushes; } };
}

test('server addresses use TLS except explicit loopback development addresses; URL credentials and fragments are rejected', () => {
  assert.equal(Cloud.serverURL(' https://sync.example.test/ '), 'https://sync.example.test');
  assert.equal(Cloud.serverURL('http://127.0.0.1:18893'), 'http://127.0.0.1:18893');
  for (const url of ['http://external.example', 'https://user:secret@example.test', 'https://example.test/#secret', 'javascript:alert(1)', 'file:///tmp/data', 'https://example.test/?token=secret']) assert.throws(() => Cloud.serverURL(url), /HTTPS/);
});

test('pending uploads are not labelled synced and unknown quantities/times remain unknown', () => {
  assert.equal(Cloud.describe(connected({ pending: 3 })).label, '有更改待上传');
  assert.equal(Cloud.describe({}).pending, null); assert.equal(Cloud.describe({ pending: null }).pending, null);
  assert.equal(Cloud.describe({}).lastSync, '尚未成功同步');
  for (const [state, label] of [['local','纯本地'],['syncing','同步中'],['offline','离线待重试'],['paused','已暂停'],['conflict','有冲突待处理'],['auth_required','需要重新登录']]) assert.equal(Cloud.describe({ state }).label, label);
  assert.equal(Cloud.describe({ connected:true,syncing:true }).label,'同步中');
  assert.equal(Cloud.describe({ connected:true,errorCode:'HTTP_401' }).label,'需要重新登录');
  assert.equal(Cloud.describe({ connected:true,conflicts:2 }).label,'有冲突待处理');
  assert.equal(Cloud.describe({ connected:true,autoSync:false }).label,'已暂停');
});

test('connection requires explicit merge agreement and clears password after the single bounded local request', async () => {
  const h = harness(); await h.api.refresh(); h.fill(); h.el('cloudMergeConfirmed').checked = false;
  assert.equal(await h.api.connect(), false); assert.equal(h.calls.some(call => call.method === 'POST'), false);
  h.el('cloudMergeConfirmed').checked = true; assert.equal(await h.api.connect(), true);
  assert.deepEqual(h.calls.find(call => call.url === '/__cloud/connect').body, { serverUrl: 'https://sync.example.test', username: 'researcher', password: 'top-secret-password', deviceName: '我的 Mac', mergeConfirmed: true });
  assert.equal(h.el('cloudPassword').value, ''); assert.equal(h.el('cloudMergeConfirmed').checked, false); assert.equal(h.flushes, 1);
  assert.equal(h.elements.some(item => item.textContent?.includes('top-secret-password')), false); h.api.destroy();
});

test('flush failure prevents sending credentials, and ongoing work blocks state-changing synchronization', async () => {
  const h = harness({ status: connected(), flush: () => false }); await h.api.refresh(); h.fill();
  assert.equal(await h.api.connect(), false); assert.equal(h.el('cloudPassword').value, ''); assert.equal(h.calls.some(call => call.method === 'POST'), false);
  assert.match(h.el('cloudSyncMessage').textContent, /尚未保存/);
  h.setBusy(true); assert.equal(await h.api.sync(), false); assert.equal(h.calls.some(call => call.url === '/__cloud/sync'), false); h.api.destroy();
});

test('in-flight cloud operation cannot be submitted twice and a failed connection does not retain password', async () => {
  let reject;
  const h = harness({ fetch: call => call.url === '/__cloud/connect' ? new Promise((_, no) => { reject = no; }) : null }); await h.api.refresh(); h.fill();
  const connecting = h.api.connect(); await tick(); assert.equal(await h.api.connect(), false); assert.equal(await h.api.sync(), false);
  assert.equal(h.calls.filter(call => call.url === '/__cloud/connect').length, 1); reject(new Error('服务器暂不可用')); assert.equal(await connecting, false);
  assert.equal(h.el('cloudPassword').value, ''); assert.match(h.el('cloudSyncMessage').textContent, /暂不可用/); h.api.destroy();
});

test('remote revision is deferred while editing, then applied through the host callback without fetching state directly', async () => {
  const h = harness(); await h.api.refresh(); h.setBusy(true); h.setStatus(connected({ remoteAppliedRevision: 8 })); await h.api.refresh();
  assert.deepEqual(h.applied, []); assert.equal(h.el('cloudApplyReceived').hidden, false); assert.equal(h.el('cloudApplyReceived').disabled, true);
  h.setBusy(false); await h.el('cloudApplyReceived').fire('click'); assert.deepEqual(h.applied, [8]); assert.equal(h.el('cloudApplyReceived').hidden, true);
  await h.api.refresh(); assert.deepEqual(h.applied, [8]); assert.equal(h.calls.some(call => call.url === '/__state'), false); h.api.destroy();
});

test('host refusing an incoming revision preserves the pending update for a later attempt', async () => {
  let accept = false; const h = harness({ status: connected({ remoteAppliedRevision: 12 }), applyRemote: () => accept }); await h.api.refresh();
  assert.equal(h.el('cloudApplyReceived').hidden, false); accept = true; await h.el('cloudApplyReceived').fire('click');
  assert.deepEqual(h.applied, [12,12]); assert.equal(h.el('cloudApplyReceived').hidden, true); h.api.destroy();
});

test('an authoritative hydrated baseline consumes historical markers without closing a retained reader or requiring a session', async () => {
  for (const online of [false, true]) {
    const h = harness({status: connected({connected:online, autoSync:false, remoteAppliedRevision:15}), getAppliedRevision:()=>18, applyRemote:()=>false, overview:true});
    h.setBusy(true); await h.api.refresh();
    assert.deepEqual(h.applied, []); assert.equal(h.el('cloudApplyReceived').hidden, true);
    assert.equal(h.surfaces.CloudSyncOverview.deferred, false);
    assert.equal(h.el('cloudSyncMessage').textContent || '', '');
    assert.equal(h.calls.some(call=>call.method==='POST'), false); h.api.destroy();
  }
});

test('status arriving before hydration retains its revision and clears it immediately only after an authoritative receipt', async () => {
  let baseline = null;
  const h = harness({status:connected({remoteAppliedRevision:8}), getAppliedRevision:()=>baseline});
  h.setBusy(true); await h.api.refresh();
  assert.equal(h.el('cloudApplyReceived').hidden, false); assert.deepEqual(h.applied, []);
  const requests = h.calls.length;
  baseline = 8; h.api.reconcileAppliedRevision();
  assert.equal(h.el('cloudApplyReceived').hidden, true); assert.equal(h.el('cloudSyncMessage').textContent, '');
  assert.equal(h.calls.length, requests, 'the hydration receipt does not fetch or sync');
  h.setBusy(false); await h.api.refresh(); assert.deepEqual(h.applied, []); h.api.destroy();
});

test('the first status is not skipped when a remote update is newer than the completed hydration', async () => {
  const h = harness({status:connected({remoteAppliedRevision:9}), getAppliedRevision:()=>8});
  await h.api.refresh(); assert.deepEqual(h.applied, [9]); assert.equal(h.el('cloudApplyReceived').hidden, true); h.api.destroy();
});

test('a real update racing hydration remains deferred when hydration adopted only an earlier revision', async () => {
  let baseline = null;
  const h = harness({status:connected({remoteAppliedRevision:9}), getAppliedRevision:()=>baseline});
  h.setBusy(true); await h.api.refresh(); baseline = 8; h.api.reconcileAppliedRevision();
  assert.equal(h.el('cloudApplyReceived').hidden, false); assert.deepEqual(h.applied, []);
  h.setBusy(false); await h.el('cloudApplyReceived').fire('click');
  assert.deepEqual(h.applied, [9]); assert.equal(h.el('cloudApplyReceived').hidden, true); h.api.destroy();
});

test('write guards retain a new marker until a completed durable merge confirms it is already adopted', async () => {
  let baseline = 8;
  const h = harness({status:connected({remoteAppliedRevision:8}),getAppliedRevision:()=>baseline});
  await h.api.refresh(); baseline = null; h.setBusy(true); h.setStatus(connected({remoteAppliedRevision:10}));
  await h.api.refresh(); assert.equal(h.el('cloudApplyReceived').hidden, false); assert.deepEqual(h.applied, []);
  baseline = 11; h.api.reconcileAppliedRevision();
  assert.equal(h.el('cloudApplyReceived').hidden, true); assert.deepEqual(h.applied, []); h.api.destroy();
});

test('an invalid, missing or throwing baseline cannot consume an incoming revision', async () => {
  for (const read of [undefined, ()=>null, ()=>undefined, ()=>NaN, ()=>Infinity, ()=>-1, ()=>1.5, ()=>'100', ()=>Number.MAX_SAFE_INTEGER+1, ()=>{throw Error('not hydrated');}]) {
    const h = harness({status:connected({remoteAppliedRevision:8}), getAppliedRevision:read, applyRemote:()=>false});
    await h.api.refresh(); assert.deepEqual(h.applied, [8]); assert.equal(h.el('cloudApplyReceived').hidden, false); h.api.destroy();
  }
});

test('a failed genuine update remains retryable and success consumes it exactly once with a baseline hook', async () => {
  let accept = false;
  const h = harness({status:connected({remoteAppliedRevision:9}),getAppliedRevision:()=>8,applyRemote:()=>accept});
  await h.api.refresh(); assert.deepEqual(h.applied, [9]); assert.equal(h.el('cloudApplyReceived').hidden, false);
  accept = true; await h.el('cloudApplyReceived').fire('click'); await h.api.refresh();
  assert.deepEqual(h.applied, [9,9]); assert.equal(h.el('cloudApplyReceived').hidden, true); h.api.destroy();
});

test('a late failed or rejected apply cannot resurrect a revision already adopted by a concurrent durable merge', async () => {
  for (const rejects of [false,true]) {
    let baseline = 8, finish;
    const h = harness({status:connected({remoteAppliedRevision:9}),getAppliedRevision:()=>baseline,applyRemote:()=>new Promise((resolve,reject)=>{finish=()=>rejects?reject(Error('old apply failed')):resolve(false);})});
    const pending = h.api.refresh(); await tick();
    baseline = 10; h.api.reconcileAppliedRevision(); finish(); await pending;
    assert.equal(h.el('cloudApplyReceived').hidden, true); assert.equal(h.el('cloudSyncMessage').textContent || '', '');
    await h.api.refresh(); assert.deepEqual(h.applied,[9]); h.api.destroy();
  }
});

test('reconciling an adopted marker preserves an unrelated save error and a newer pending revision', async () => {
  let baseline = 8;
  const h = harness({status:connected({remoteAppliedRevision:9}),getAppliedRevision:()=>baseline,applyRemote:()=>false,flush:()=>false});
  await h.api.refresh(); await h.el('cloudApplyReceived').fire('click');
  assert.match(h.el('cloudSyncMessage').textContent,/先保存/);
  baseline = 9; h.api.reconcileAppliedRevision(); assert.equal(h.el('cloudApplyReceived').hidden,true);
  assert.match(h.el('cloudSyncMessage').textContent,/先保存/);
  h.setStatus(connected({remoteAppliedRevision:12})); await h.api.refresh();
  baseline = 10; h.api.reconcileAppliedRevision(); assert.equal(h.el('cloudApplyReceived').hidden,false);
  h.api.destroy();
});

test('clicking apply after an independent load adopted the pending revision does not flush or reload documents', async () => {
  let baseline = 8;
  const h = harness({status:connected({remoteAppliedRevision:9}),getAppliedRevision:()=>baseline,applyRemote:()=>false});
  await h.api.refresh(); baseline = 9; await h.el('cloudApplyReceived').fire('click');
  assert.equal(h.flushes,0); assert.deepEqual(h.applied,[9]); assert.equal(h.el('cloudApplyReceived').hidden,true); h.api.destroy();
});

test('a stale status response cannot reconnect the UI after an explicit disconnect', async () => {
  let delayed = false, release;
  const h = harness({ status: connected(), fetch: call => delayed && call.url === '/__cloud/status' ? (delayed = false, new Promise(done => { release = () => done({ ok: true, json: async () => connected() }); })) : undefined }); await h.api.refresh();
  delayed = true; const old = h.api.refresh(); await tick(); await h.el('cloudDisconnect').fire('click'); release(); await old;
  assert.equal(h.api.getStatus().connected, false); assert.equal(h.api.getStatus().state, 'local'); h.api.destroy();
});

test('automatic-sync setting does not masquerade as sync success or replace form drafts on status refresh', async () => {
  const h = harness({ status: connected({ state: 'offline', pending: 2 }) }); await h.api.refresh();
  h.el('cloudAutoSync').checked = false; await h.el('cloudAutoSync').fire('change');
  assert.deepEqual(h.calls.find(call => call.url === '/__cloud/settings').body, { autoSync: false }); assert.equal(h.api.getStatus().pending, 2);
  h.el('cloudServerUrl').value = 'https://new-server.example'; await h.api.refresh(); assert.equal(h.el('cloudServerUrl').value, 'https://new-server.example'); h.api.destroy();
});

test('device revocation requires a second explicit action and never removes local content in the UI', async () => {
  const h = harness({ status: connected(), fetch: call => call.url === '/__cloud/devices' ? { ok: true, json: async () => ({ devices: [{ id: 'other', name: '<script>device</script>', lastSeenAt: 1789000000 }] }) } : undefined }); await h.api.refresh(); await h.api.devices();
  assert.ok(h.elements.some(item=>item.tagName==='small'&&item.textContent.includes('2026')),'Unix seconds display the actual device activity year');
  await h.elements.find(item => item.textContent === '撤销访问').fire('click'); assert.equal(h.calls.some(call => call.url === '/__cloud/revoke'), false);
  await h.elements.find(item => item.textContent === '确认撤销').fire('click'); assert.deepEqual(h.calls.find(call => call.url === '/__cloud/revoke').body, { deviceId: 'other' });
  assert.equal(h.elements.some(item => item.textContent === '<script>device</script>'), true); h.api.destroy();
});

test('conflicts show both literal versions, preserve deletion meaning, and resolve only the chosen conflict', async () => {
  let unresolved = true;
  const h = harness({ conflictKit: true, status: connected({ state: 'conflict', conflicts: 1 }), fetch: call => {
    if (call.url === '/__cloud/conflicts') return { ok: true, json: async () => ({ conflicts: unresolved ? [{ id: 'c-1', revision: 'a'.repeat(64), title: '人工笔记', local: { content: '<img onerror="x">' }, remote: null }] : [] }) };
    if (call.url === '/__cloud/resolve') { unresolved = false; return { ok: true, json: async () => connected({ remoteAppliedRevision: 13, conflicts: 0 }) }; }
  } }); await h.api.refresh(); await h.api.conflicts();
  const entry = h.surfaces.CloudConflictReview.entries[0];
  const versions = [entry.localPreview, entry.remotePreview];
  assert.ok(versions.some(value => value.includes('<img onerror'))); assert.ok(versions.includes('此版本已删除。'));
  await h.surfaces.CloudConflictReview.onChoose('c-1','remote',entry.revision);
  assert.deepEqual(h.calls.find(call => call.url === '/__cloud/resolve').body, { id: 'c-1', choice: 'remote', revision: 'a'.repeat(64) }); assert.deepEqual(h.applied, [13]); assert.equal(h.flushes, 1); h.api.destroy();
});

test('a recovered status clears the obsolete network failure without hiding a current save failure', async () => {
  let fail = true;
  const h = harness({ status: connected(), fetch: call => { if (call.url === '/__cloud/status' && fail) throw new Error('临时网络故障'); } });
  await h.api.refresh(); assert.match(h.el('cloudSyncMessage').textContent, /临时网络故障/);
  fail = false; await h.api.refresh(); assert.equal(h.el('cloudSyncMessage').textContent, '');
  h.api.destroy();
  const blocked = harness({ status: connected({ error: '上次网络失败' }), flush: () => false }); await blocked.api.refresh();
  assert.equal(await blocked.api.sync(), false); assert.match(blocked.el('cloudSyncMessage').textContent, /本机更改尚未保存/);
  await blocked.api.refresh(); assert.match(blocked.el('cloudSyncMessage').textContent, /本机更改尚未保存/); blocked.api.destroy();
});

test('finishing an already-confirmed operation does not reopen a conflict dialog dismissed while waiting', async () => {
  let finish;
  const h = harness({ conflictKit: true, status: connected({ conflicts:1 }), fetch: call => {
    if (call.url === '/__cloud/conflicts') return { ok:true,json:async()=>({conflicts:[{id:'slow',revision:'b'.repeat(64),title:'待确认笔记',local:'本机',remote:'云端'}]}) };
    if (call.url === '/__cloud/resolve') return new Promise(done=>{finish=()=>done({ok:true,json:async()=>connected()});});
  } }); await h.api.refresh(); await h.api.conflicts();
  const choosing=h.surfaces.CloudConflictReview.onChoose('slow','remote','b'.repeat(64)); await tick();
  h.el('cloudSyncDialog').close(); finish(); await choosing;
  assert.equal(h.el('cloudSyncDialog').open,false); assert.equal(h.calls.filter(call=>call.url==='/__cloud/resolve').length,1); h.api.destroy();
});

test('conflict review prioritizes readable content while keeping complete record fields available', async () => {
  const value={id:'internal-id',title:'方法笔记',workspace:'科研',content:'这里是人工修订。',updatedAt:1789000000000,sourceAttachmentIds:['paper-1'],tags:['控制'],customField:'保留的完整数据'};
  const preview=Cloud.conflictPreview(value);assert.match(preview,/标题：方法笔记/);assert.match(preview,/正文\n这里是人工修订/);assert.match(preview,/关联资料：1 份/);assert.doesNotMatch(preview,/internal-id|1789000000000/);
  const h=harness({conflictKit:true,status:connected({conflicts:1}),fetch:call=>call.url==='/__cloud/conflicts'?{ok:true,json:async()=>({conflicts:[{id:'review',revision:'c'.repeat(64),local:value,remote:null}]})}:undefined});await h.api.refresh();await h.api.conflicts();
  const entry=h.surfaces.CloudConflictReview.entries[0];assert.match(entry.localFields,/保留的完整数据/);assert.equal(entry.remoteDeleted,true);h.api.destroy();
});

test('connected users can reopen configuration, keep drafts during refresh, and cancel without changing connection', async () => {
  const h=harness({status:connected({target:{serverUrl:'https://sync.example.test'}})}); await h.api.refresh();
  const form=h.elements.find(e=>e.tagName==='form'); assert.equal(form.hidden,true);
  await h.el('cloudEditConnection').fire('click'); assert.equal(form.hidden,false);
  assert.equal(h.el('cloudUsername').value,'researcher'); assert.equal(h.el('cloudPassword').value,'');
  h.el('cloudDeviceName').value='新版设备名称'; await h.api.refresh(); assert.equal(h.el('cloudDeviceName').value,'新版设备名称');
  h.el('cloudPassword').value='synthetic'; await h.el('cloudEditConnection').fire('click');
  assert.equal(form.hidden,true); assert.equal(h.el('cloudPassword').value,'');
  assert.equal(h.calls.some(c=>c.method==='POST'),false);h.api.destroy();
});

test('SSH directory moves require inspection and agreement and invalidate both when host changes', async () => {
  const config={target:'fixture-host',sshPort:0,localPort:18787,remotePort:8787}, remote={dataPath:'/home/fixture/cloud',databasePath:'/home/fixture/cloud/cloud.sqlite3'};
  const h=harness({storage:true,status:connected(),fetch:c=>c.url.startsWith('/__cloud/ssh')?{ok:true,json:async()=>({config,remote})}:null});await h.api.refresh();
  await h.el('cloudSSHSettings').fire('click');
  const surface=()=>h.surfaces.CloudSSHStorage;assert.equal(surface().draft.verified,false);await surface().onMove();
  await surface().onInspect();assert.equal(surface().draft.verified,true);
  surface().onChange('destination','/home/fixture/next');await surface().onMove();
  surface().onChange('confirmed',true);assert.equal(surface().draft.confirmed,true);
  surface().onChange('target','another-host');assert.equal(surface().draft.verified,false);assert.equal(surface().draft.confirmed,false);await surface().onMove();
  assert.equal(h.calls.some(c=>c.url==='/__cloud/ssh/move'),false);h.api.destroy();
});

test('saved endpoint and account prefill the connection form once without clobbering later drafts', async () => {
  const h=harness({status:connected({target:{serverUrl:'https://sync.example.test'}})});await h.api.refresh();
  assert.equal(h.el('cloudServerUrl').value,'https://sync.example.test');assert.equal(h.el('cloudUsername').value,'researcher');assert.equal(h.el('cloudDeviceName').value,'我的电脑');
  h.el('cloudDeviceName').value='手动设备名';await h.api.refresh();assert.equal(h.el('cloudDeviceName').value,'手动设备名');assert.equal(h.el('cloudPassword').value,'');h.api.destroy();
});

test('late first status does not overwrite an already entered connection form', async () => {
  let release;const h=harness({fetch:call=>call.url==='/__cloud/status'?new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>connected()});}):null});
  h.el('cloudServerUrl').value='https://typed.example.test';await h.el('cloudServerUrl').fire('input');release();await h.api.refresh();
  assert.equal(h.el('cloudServerUrl').value,'https://typed.example.test');h.api.destroy();
});

test('authentication and conflicts cannot be hidden by a stale synced label', () => {
  assert.equal(Cloud.describe(connected({errorCode:'HTTP_401'})).state,'auth_required');
  assert.equal(Cloud.describe(connected({conflicts:2})).state,'conflict');
  assert.equal(Cloud.describe(connected({syncing:true})).state,'syncing');
});

test('saved binding without a session is recovery, not first-time setup or a connected account', () => {
  const view=Cloud.describe({state:'local',connected:false,serverUrl:'http://127.0.0.1:18787',target:{serverUrl:'http://127.0.0.1:18787',accountId:'fixture-original'},account:null,device:null,pending:101});
  assert.equal(view.state,'sign_in_required');assert.equal(view.connected,false);assert.equal(view.needsSignIn,true);assert.equal(view.bound,true);assert.equal(view.pending,101);
  assert.equal(Cloud.describe({state:'local',connected:false}).state,'local');assert.equal(Cloud.describe({state:'local',connected:false}).bound,false);
});

test('bound missing-session form requires original username, explains SSH endpoint, and never resets binding', async () => {
  const fixture={state:'local',connected:false,serverUrl:'http://127.0.0.1:18787',target:{serverUrl:'http://127.0.0.1:18787',accountId:'fixture-original'},pending:101};
  const h=harness({status:fixture,fetch:call=>call.url==='/__cloud/ssh'?{ok:true,json:async()=>({config:{target:'qa@fixture-host',localPort:18787,remotePort:8787}})}:null});await h.api.refresh();await tick();
  assert.equal(h.el('cloudServerUrl').value,'http://127.0.0.1:18787');assert.equal(h.el('cloudServerUrl').readOnly,true);assert.equal(h.el('cloudUsername').value,'');
  assert.match(h.el('cloudConnectionIntro').textContent,/没有可用的登录会话/);assert.match(h.el('cloudConnectionIntro').textContent,/用户名、密码/);assert.match(h.el('cloudServerHint').textContent,/qa@fixture-host/);assert.equal(h.el('cloudConnectionSSH').hidden,false);assert.equal(h.el('cloudConnect').textContent,'登录并恢复同步');
  h.el('cloudMergeConfirmed').checked=true;h.el('cloudPassword').value='synthetic';assert.equal(await h.api.connect(),false);assert.equal(h.doc.activeElement,h.el('cloudUsername'));assert.match(h.el('cloudSyncMessage').textContent,/不同于 SSH/);assert.equal(h.calls.some(x=>x.method==='POST'),false);h.api.destroy();
});

test('opening SSH configuration reads local metadata without automatically inspecting a remote host', async () => {
  const config={target:'fixture-host',sshPort:0,localPort:18787,remotePort:8787};
  const h=harness({storage:true,status:connected({target:{serverUrl:'http://127.0.0.1:18787'}}),fetch:c=>c.url==='/__cloud/ssh'?{ok:true,json:async()=>({config})}:null});await h.api.refresh();await h.el('cloudSSHSettings').fire('click');
  assert.equal(h.surfaces.CloudSSHStorage.draft.config.target,'fixture-host');
  assert.equal(h.calls.some(c=>c.url==='/__cloud/ssh/inspect'),false);assert.equal(h.calls.some(c=>c.method==='POST'),false);h.api.destroy();
});

const sshConfig = {target:'fixture-host',sshPort:0,localPort:18787,remotePort:8787};
const sshRemote = accounts => ({active:true,protocol:1,dataPath:'/home/fixture/cloud',accounts:accounts || [{id:'fixture-workspace',username:'fixture-account'}]});
const sshOK = value => ({ok:true,json:async()=>value});
const sshSurface = h => h.surfaces.CloudSSHConnection;
const sshHarness = options => harness({ssh:true,...options,fetch:async call => {
  const custom=await options?.fetch?.(call);if(custom)return custom;
  if(call.url==='/__cloud/ssh')return sshOK({config:sshConfig,hosts:[{target:'fixture-host',label:'Fixture host'}]});
  if(call.url==='/__cloud/ssh/probe')return sshOK({config:{localPort:18787,remotePort:8787,sshPort:0,target:call.body.config.target},remote:sshRemote()});
  if(call.url==='/__cloud/ssh/connect')return sshOK({config:sshConfig,status:connected({target:{serverUrl:'http://127.0.0.1:18787',accountId:'fixture-workspace'}}),remote:sshRemote()});
}});

test('SSH opens local host metadata only and checks selected service before enabling workspace connection',async()=>{
 const h=sshHarness();await h.api.refresh();await h.api.openSSHConnection();assert.equal(h.calls.some(c=>c.method==='POST'),false);
 assert.equal(sshSurface(h).hosts[0].target,'fixture-host');assert.equal(sshSurface(h).draft.probe,null);
 await sshSurface(h).onConnect();assert.equal(h.calls.some(c=>c.url==='/__cloud/ssh/connect'),false);
 await sshSurface(h).onProbe();assert.equal(sshSurface(h).draft.accountId,'fixture-workspace');assert.match(sshSurface(h).draft.message,/检查通过/);
 sshSurface(h).onChange('confirmed',true);await sshSurface(h).onConnect();
 const call=h.calls.find(c=>c.url==='/__cloud/ssh/connect');assert.deepEqual(call.body,{config:sshConfig,accountId:'fixture-workspace',deviceName:'我的电脑',mergeConfirmed:true,autoSync:true});assert.equal(Object.hasOwn(call.body,'password'),false);assert.equal(h.flushes,1);assert.equal(h.el('cloudSyncDialog').open,false);h.api.destroy();
});

test('SSH reopening moves the same dialog before workspace siblings and restores its opener focus',async()=>{
 const captured=[];const h=sshHarness({onShowModal:active=>captured.push(active)});await h.api.refresh();
 const workspace=h.doc.createElement('main');h.doc.body.append(workspace);
 const opener=h.el('cloudSSHSettings');await h.api.openSSHConnection(undefined,opener);
 const dialog=h.el('cloudSyncDialog'),header=dialog.children[0];
 assert.equal(h.doc.body.firstElementChild,dialog);assert.equal(captured[0],opener);
 assert.equal(h.doc.body.children.includes(workspace),true);dialog.close();await tick();assert.equal(h.doc.activeElement,opener);
 const preceding=h.doc.createElement('section');h.doc.body.prepend(preceding);
 await h.api.openSSHConnection(undefined,opener);
 assert.equal(h.el('cloudSyncDialog'),dialog);assert.equal(dialog.children[0],header);assert.equal(h.doc.body.firstElementChild,dialog);
 assert.equal(h.doc.body.children.filter(node=>node===dialog).length,1);assert.equal(captured[1],opener);
 dialog.close();await tick();assert.equal(h.doc.activeElement,opener);h.api.destroy();
});

test('SSH probe is invalidated by any connection edit, and unknown ports never reach the backend',async()=>{
 const h=sshHarness();await h.api.refresh();await h.api.openSSHConnection();await sshSurface(h).onProbe();sshSurface(h).onChange('confirmed',true);sshSurface(h).onChange('target','another-host');assert.equal(sshSurface(h).draft.probe,null);assert.equal(sshSurface(h).draft.confirmed,false);await sshSurface(h).onConnect();assert.equal(h.calls.some(c=>c.url==='/__cloud/ssh/connect'),false);
 sshSurface(h).onChange('localPort','70000');await sshSurface(h).onProbe();assert.equal(h.calls.filter(c=>c.url==='/__cloud/ssh/probe').length,1);assert.match(sshSurface(h).draft.message,/65535/);h.api.destroy();
});

test('SSH first connection requires an explicit account choice when multiple remote workspaces exist',async()=>{
 const h=sshHarness({fetch:c=>c.url==='/__cloud/ssh/probe'?sshOK({config:sshConfig,remote:sshRemote([{id:'a',username:'A'},{id:'b',username:'B'}])}):null});await h.api.refresh();await h.api.openSSHConnection();await sshSurface(h).onProbe();assert.equal(sshSurface(h).draft.accountId,'');sshSurface(h).onChange('confirmed',true);await sshSurface(h).onConnect();assert.equal(h.calls.some(c=>c.url==='/__cloud/ssh/connect'),false);
 sshSurface(h).onChange('accountId','b');assert.equal(sshSurface(h).draft.confirmed,false);sshSurface(h).onChange('confirmed',true);await sshSurface(h).onConnect();assert.equal(h.calls.find(c=>c.url==='/__cloud/ssh/connect').body.accountId,'b');h.api.destroy();
});

test('SSH recovery retains original account identity even when a forged alternate selection is supplied',async()=>{
 const status={connected:false,target:{serverUrl:'http://127.0.0.1:18787',accountId:'original'},pending:101};
 const h=sshHarness({status,fetch:c=>c.url==='/__cloud/ssh/probe'?sshOK({config:sshConfig,remote:sshRemote([{id:'other',username:'Other'}])}):null});await h.api.refresh();await h.api.openSSHConnection();await sshSurface(h).onProbe();assert.equal(sshSurface(h).draft.accountId,'');assert.match(sshSurface(h).draft.message,/绑定的远端账号/);sshSurface(h).onChange('accountId','other');sshSurface(h).onChange('confirmed',true);await sshSurface(h).onConnect();assert.equal(h.calls.some(c=>c.url==='/__cloud/ssh/connect'),false);assert.equal(h.api.getStatus().pending,101);h.api.destroy();
});

test('SSH reauthorization preserves the current bound auto-sync preference and reports a paused recovery',async()=>{
 for(const autoSync of [false,true,undefined]) {
  const status={connected:false,autoSync,target:{serverUrl:'http://127.0.0.1:18787',accountId:'fixture-workspace'},pending:119};
  const h=sshHarness({status});await h.api.refresh();await h.api.openSSHConnection();await sshSurface(h).onProbe();
  sshSurface(h).onChange('confirmed',true);await sshSurface(h).onConnect();
  const request=h.calls.find(call=>call.url==='/__cloud/ssh/connect');
  assert.equal(request.body.autoSync,autoSync===true);assert.equal(request.body.accountId,'fixture-workspace');
  assert.equal(h.calls.some(call=>call.url==='/__cloud/sync'||call.url==='/__cloud/settings'),false);
  if(autoSync!==true)assert.match(h.el('cloudSyncMessage').textContent,/自动同步保持暂停/);
  h.api.destroy();
 }
});

test('SSH reconnect reads the refreshed pause preference at submit rather than when opening its dialog',async()=>{
 const target={serverUrl:'http://127.0.0.1:18787',accountId:'fixture-workspace'};
 const h=sshHarness({status:{connected:false,autoSync:true,target}});
 await h.api.refresh();await h.api.openSSHConnection();await sshSurface(h).onProbe();
 h.setStatus({connected:false,autoSync:false,target});await h.api.refresh();
 sshSurface(h).onChange('confirmed',true);await sshSurface(h).onConnect();
 assert.equal(h.calls.find(call=>call.url==='/__cloud/ssh/connect').body.autoSync,false);h.api.destroy();
});

test('SSH consent and payload share a live sync mode and a preference change requires fresh confirmation',async()=>{
 const target={serverUrl:'http://127.0.0.1:18787',accountId:'fixture-workspace'};
 const h=sshHarness({status:{connected:false,autoSync:false,target}});
 await h.api.refresh();await h.api.openSSHConnection();await sshSurface(h).onProbe();
 assert.equal(sshSurface(h).draft.autoSync,false);sshSurface(h).onChange('confirmed',true);
 h.setStatus({connected:false,autoSync:true,target});await h.api.refresh();
 assert.equal(sshSurface(h).draft.autoSync,true);assert.equal(sshSurface(h).draft.confirmed,false);
 await sshSurface(h).onConnect();assert.equal(h.calls.some(call=>call.url==='/__cloud/ssh/connect'),false);
 sshSurface(h).onChange('confirmed',true);await sshSurface(h).onConnect();
 assert.equal(h.calls.find(call=>call.url==='/__cloud/ssh/connect').body.autoSync,true);h.api.destroy();
});

test('account-password recovery also retains an existing pause instead of relying on the server true default',async()=>{
 const h=harness({status:{connected:false,autoSync:false,target:{serverUrl:'https://sync.example.test',accountId:'original'}}});
 await h.api.refresh();h.fill();await h.api.connect();
 assert.equal(h.calls.find(call=>call.url==='/__cloud/connect').body.autoSync,false);
 assert.equal(h.calls.some(call=>call.url==='/__cloud/sync'),false);assert.match(h.el('cloudSyncMessage').textContent,/自动同步保持暂停/);h.api.destroy();
});

test('a dismissed SSH probe never updates another dialog and cannot create a stale connection',async()=>{
 let release;const h=sshHarness({fetch:c=>c.url==='/__cloud/ssh/probe'?new Promise(resolve=>{release=()=>resolve(sshOK({config:sshConfig,remote:sshRemote()}));}):null});await h.api.refresh();await h.api.openSSHConnection();const old=sshSurface(h);const checking=old.onProbe();await tick();h.el('cloudSyncDialog').close();release();await checking;await h.api.openSSHConnection('second-host');assert.equal(sshSurface(h).draft.config.target,'second-host');assert.equal(sshSurface(h).draft.probe,null);await old.onConnect();assert.equal(h.calls.some(c=>c.url==='/__cloud/ssh/connect'),false);h.api.destroy();
});

test('SSH connect waits for local save and rejects duplicate submits while preserving truthful pending state',async()=>{
 let release;const h=sshHarness({fetch:c=>c.url==='/__cloud/ssh/connect'?new Promise(resolve=>{release=()=>resolve(sshOK({config:sshConfig,status:connected({pending:7,state:'pending'})}));}):null});await h.api.refresh();await h.api.openSSHConnection();await sshSurface(h).onProbe();sshSurface(h).onChange('confirmed',true);const submit=sshSurface(h).onConnect();await tick();await sshSurface(h).onConnect();assert.equal(h.calls.filter(c=>c.url==='/__cloud/ssh/connect').length,1);assert.equal(sshSurface(h).draft.busy,'connect');h.el('cloudSyncDialog').close();release();await submit;assert.equal(h.el('cloudSyncDialog').open,false);assert.match(h.el('cloudSyncMessage').textContent,/进度以上方实际状态/);h.api.destroy();
});

test('SSH connection aborts before remote mutation if the dialog closes during local flush',async()=>{
 let release;const h=sshHarness({flush:()=>new Promise(resolve=>{release=resolve})});await h.api.refresh();await h.api.openSSHConnection();await sshSurface(h).onProbe();sshSurface(h).onChange('confirmed',true);const submit=sshSurface(h).onConnect();await tick();h.el('cloudSyncDialog').close();release(true);await submit;assert.equal(h.calls.some(c=>c.url==='/__cloud/ssh/connect'),false);h.api.destroy();
});

test('SSH empty server and save errors remain actionable without invented accounts or passwords',async()=>{
 const empty=sshHarness({fetch:c=>c.url==='/__cloud/ssh/probe'?sshOK({config:sshConfig,remote:sshRemote([])}):null});await empty.api.refresh();await empty.api.openSSHConnection();await sshSurface(empty).onProbe();assert.equal(sshSurface(empty).draft.accountId,'');assert.match(sshSurface(empty).draft.message,/没有可连接的同步账号/);empty.api.destroy();
 const failure=sshHarness({flush:()=>false});await failure.api.refresh();await failure.api.openSSHConnection();await sshSurface(failure).onProbe();sshSurface(failure).onChange('confirmed',true);await sshSurface(failure).onConnect();assert.equal(failure.calls.some(c=>c.url==='/__cloud/ssh/connect'),false);assert.match(sshSurface(failure).draft.message,/尚未保存/);assert.equal(sshSurface(failure).draft.busy,'');failure.api.destroy();
});

const storageRemote = {dataPath:'/home/fixture/cloud',databasePath:'/home/fixture/cloud/cloud.sqlite3'};
const storageJob = (state, message, overrides = {}) => ({state,message,source:storageRemote.dataPath,destination:'/home/fixture/new-cloud',...overrides});
const storageSurface = h => h.surfaces.CloudSSHStorage;
const storageHarness = options => harness({storage:true,overview:true,status:connected(),...options,fetch:async call => {
  const custom=await options?.fetch?.(call);if(custom)return custom;
  if(call.url==='/__cloud/ssh')return sshOK({config:sshConfig,remote:storageRemote});
  if(call.url==='/__cloud/ssh/inspect'||call.url==='/__cloud/ssh/save')return sshOK({config:call.body.config,remote:storageRemote});
  if(call.url==='/__cloud/ssh/move')return sshOK({config:sshConfig,remote:storageRemote,job:storageJob('running','正在复制并校验',{source:call.body.expectedPath,destination:call.body.dataPath})});
}});
const openStorage = async h => {await h.api.refresh();await tick();await h.el('cloudSSHSettings').fire('click');};
const prepareMove = async h => {await storageSurface(h).onInspect();storageSurface(h).onChange('destination','/home/fixture/new-cloud');storageSurface(h).onChange('confirmed',true);};

test('late maintenance metadata cannot replace an edited newly opened maintenance dialog',async t=>{
  let delay=false,release;
  const h=storageHarness({fetch:call=>call.url==='/__cloud/ssh'&&delay?(delay=false,new Promise(resolve=>{release=()=>resolve(sshOK({config:{...sshConfig,target:'stale-host'}}));})):null});t.after(()=>h.api.destroy());
  await h.api.refresh();await tick();delay=true;
  const oldOpen=h.el('cloudSSHSettings').fire('click');await tick();h.el('cloudSyncDialog').close();
  await h.el('cloudSSHSettings').fire('click');storageSurface(h).onChange('target','new-unsaved-draft');storageSurface(h).onChange('destination','/new/draft/path');
  const current=storageSurface(h);release();await oldOpen;
  assert.equal(storageSurface(h),current);assert.equal(current.draft.config.target,'new-unsaved-draft');assert.equal(current.draft.destination,'/new/draft/path');
  assert.equal(h.calls.some(call=>call.method==='POST'),false);
});

test('maintenance save updates the visible server immediately and ordinary refresh keeps it',async t=>{
  let saved={...sshConfig};
  const h=storageHarness({fetch:call=>{
    if(call.url==='/__cloud/ssh')return sshOK({config:saved,remote:storageRemote});
    if(call.url==='/__cloud/ssh/save'){saved=call.body.config;return sshOK({config:saved,remote:storageRemote});}
  }});t.after(()=>h.api.destroy());await openStorage(h);
  storageSurface(h).onChange('target','saved-host');await storageSurface(h).onSave();
  assert.equal(storageSurface(h).draft.savedConfig.target,'saved-host');assert.equal(h.surfaces.CloudSyncOverview.ssh.config.target,'saved-host');
  await h.api.refresh();assert.equal(h.surfaces.CloudSyncOverview.ssh.config.target,'saved-host');
  assert.equal(h.calls.filter(call=>call.url==='/__cloud/ssh/save').length,1);
});

test('maintenance reopens with the actual completed or failed migration result',async t=>{
  for(const state of ['completed','error'])await t.test(state,async st=>{
    const job=storageJob(state,state==='completed'?'已校验并切换，旧目录保留':'迁移结果未确认，自动同步已暂停');
    const h=storageHarness({fetch:call=>call.url==='/__cloud/ssh'?sshOK({config:sshConfig,remote:storageRemote,job}):null});st.after(()=>h.api.destroy());
    await openStorage(h);assert.equal(storageSurface(h).draft.message,job.message);assert.equal(storageSurface(h).draft.kind,state==='completed'?'success':'error');assert.equal(storageSurface(h).draft.verified,false);
    h.el('cloudSyncDialog').close();await h.el('cloudSSHSettings').fire('click');assert.equal(storageSurface(h).draft.message,job.message);
    assert.equal(h.calls.some(call=>call.method==='POST'),false);
  });
});

test('destroy during HTTPS local-save preflight cannot initiate a remote connection',async t=>{
  let release;const h=harness({flush:()=>new Promise(resolve=>{release=resolve})});t.after(()=>h.api.destroy());
  await h.api.refresh();h.fill();const submit=h.api.connect();await tick();h.api.destroy();release(true);await submit;
  assert.equal(h.calls.some(call=>call.url==='/__cloud/connect'),false);assert.equal(h.el('cloudPassword').value,'');
});

test('account sign-in and edit entrances remain exclusive and hiding either clears credentials and consent',async t=>{
  const h=harness({overview:true,status:connected()});t.after(()=>h.api.destroy());await h.api.refresh();
  const view=()=>h.surfaces.CloudSyncOverview,form=h.elements.find(element=>element.tagName==='form');
  view().onEdit();assert.equal(view().editing,true);assert.equal(view().connecting,false);h.fill();
  view().onConnect();assert.equal(view().editing,false);assert.equal(view().connecting,true);assert.equal(h.el('cloudPassword').value,'');assert.equal(h.el('cloudMergeConfirmed').checked,false);
  h.fill();view().onEdit();assert.equal(view().editing,true);assert.equal(view().connecting,false);assert.equal(h.el('cloudPassword').value,'');assert.equal(h.el('cloudMergeConfirmed').checked,false);
  h.fill();view().onEdit();assert.equal(form.hidden,true);assert.equal(view().editing,false);assert.equal(view().connecting,false);assert.equal(h.el('cloudPassword').value,'');assert.equal(h.el('cloudMergeConfirmed').checked,false);
  assert.equal(h.calls.some(call=>call.method==='POST'),false);
});

test('late overview metadata cannot roll back a subsequently saved SSH configuration',async t=>{
  let delay=false,release;
  const h=storageHarness({fetch:call=>call.url==='/__cloud/ssh'&&delay?(delay=false,new Promise(resolve=>{release=()=>resolve(sshOK({config:{...sshConfig,target:'stale-overview-host'}}));})):null});t.after(()=>h.api.destroy());
  await h.api.refresh();await tick();delay=true;await h.el('cloudRefresh').fire('click');await tick();assert.ok(release);
  await h.el('cloudSSHSettings').fire('click');storageSurface(h).onChange('target','saved-after-overview-request');await storageSurface(h).onSave();
  assert.equal(h.surfaces.CloudSyncOverview.ssh.config.target,'saved-after-overview-request');release();await tick();
  assert.equal(h.surfaces.CloudSyncOverview.ssh.config.target,'saved-after-overview-request');assert.equal(storageSurface(h).draft.config.target,'saved-after-overview-request');
});

test('migration polling failure keeps operations blocked until an explicit terminal status is read',async t=>{
  let fail=false,job=storageJob('running','正在复制并校验');
  const h=storageHarness({ssh:true,fetch:call=>{
    if(call.url==='/__cloud/ssh'){if(fail)throw new Error('临时状态读取失败');return sshOK({config:sshConfig,remote:storageRemote,job});}
  }});t.after(()=>h.api.destroy());await openStorage(h);
  fail=true;await storageSurface(h).onRefresh();assert.equal(storageSurface(h).draft.uncertain,true);assert.match(storageSurface(h).draft.message,/状态读取中断/);
  const postsBefore=h.calls.filter(call=>call.method==='POST').length;
  await storageSurface(h).onInspect();await storageSurface(h).onSave();await storageSurface(h).onMove();await h.api.sync();await h.api.openSSHConnection();
  assert.equal(h.calls.filter(call=>call.method==='POST').length,postsBefore);assert.ok(storageSurface(h));
  fail=false;job=null;await storageSurface(h).onRefresh();assert.equal(storageSurface(h).draft.uncertain,true,'missing job does not prove a previously running migration stopped');
  await storageSurface(h).onSave();assert.equal(h.calls.filter(call=>call.method==='POST').length,postsBefore);
  job=storageJob('completed','已复制并校验');await storageSurface(h).onRefresh();assert.equal(storageSurface(h).draft.uncertain,false);assert.equal(storageSurface(h).draft.message,job.message);
  await storageSurface(h).onInspect();assert.equal(h.calls.filter(call=>call.url==='/__cloud/ssh/inspect').length,1);assert.equal(storageSurface(h).draft.verified,true);
});

test('changing migration destination withdraws agreement and only the newly confirmed destination is sent',async t=>{
  const h=storageHarness();t.after(()=>h.api.destroy());await openStorage(h);await prepareMove(h);
  storageSurface(h).onChange('destination','/home/fixture/revised-cloud');assert.equal(storageSurface(h).draft.confirmed,false);await storageSurface(h).onMove();
  assert.equal(h.calls.some(call=>call.url==='/__cloud/ssh/move'),false);
  storageSurface(h).onChange('confirmed',true);await storageSurface(h).onMove();
  assert.deepEqual(h.calls.find(call=>call.url==='/__cloud/ssh/move').body,{expectedPath:storageRemote.dataPath,dataPath:'/home/fixture/revised-cloud',confirmed:true});
  assert.equal(storageSurface(h).draft.confirmed,false);assert.equal(storageSurface(h).draft.verified,false);
});

test('maintenance save rejects duplicate and cross-operation submits while its request is pending',async t=>{
  let release;const h=storageHarness({fetch:call=>call.url==='/__cloud/ssh/save'?new Promise(resolve=>{release=()=>resolve(sshOK({config:call.body.config,remote:storageRemote}));}):null});t.after(()=>h.api.destroy());await openStorage(h);
  storageSurface(h).onChange('target','saved-host');const saving=storageSurface(h).onSave();await tick();
  await storageSurface(h).onSave();await storageSurface(h).onInspect();await storageSurface(h).onRefresh();await h.api.sync();storageSurface(h).onChange('target','ignored-while-saving');
  assert.equal(storageSurface(h).draft.busy,'save');assert.equal(storageSurface(h).draft.config.target,'saved-host');assert.deepEqual(h.calls.filter(call=>call.method==='POST').map(call=>call.url),['/__cloud/ssh/save']);
  h.el('cloudSyncDialog').close();release();await saving;
  assert.equal(h.el('cloudSyncDialog').open,false);assert.equal(h.surfaces.CloudSyncOverview.ssh.config.target,'saved-host','a completed save still updates the overview after its dialog closes');
});

test('migration submission is single-flight and cannot be repeated after the job starts',async t=>{
  let release;const h=storageHarness({fetch:call=>call.url==='/__cloud/ssh/move'?new Promise(resolve=>{release=()=>resolve(sshOK({config:sshConfig,remote:storageRemote,job:storageJob('running','正在复制并校验',{source:call.body.expectedPath,destination:call.body.dataPath})}));}):null});t.after(()=>h.api.destroy());await openStorage(h);await prepareMove(h);
  const moving=storageSurface(h).onMove();await tick();await storageSurface(h).onMove();await storageSurface(h).onSave();assert.equal(storageSurface(h).draft.busy,'move');
  assert.equal(h.calls.filter(call=>call.url==='/__cloud/ssh/move').length,1);assert.equal(h.calls.some(call=>call.url==='/__cloud/ssh/save'),false);
  release();await moving;assert.equal(storageSurface(h).draft.job.state,'running');await storageSurface(h).onMove();await storageSurface(h).onInspect();
  assert.equal(h.calls.filter(call=>call.url==='/__cloud/ssh/move').length,1);assert.equal(h.calls.filter(call=>call.url==='/__cloud/ssh/inspect').length,1);
});

test('unacknowledged migration submission requires status reconciliation before another operation',async t=>{
  let job=null;
  const h=storageHarness({fetch:call=>{
    if(call.url==='/__cloud/ssh')return sshOK({config:sshConfig,remote:storageRemote,job});
    if(call.url==='/__cloud/ssh/move')throw new Error('提交回复丢失');
  }});t.after(()=>h.api.destroy());await openStorage(h);await prepareMove(h);await storageSurface(h).onMove();
  assert.equal(storageSurface(h).draft.uncertain,true);assert.equal(storageSurface(h).draft.confirmed,false);assert.match(storageSurface(h).draft.message,/重新读取迁移状态/);
  await storageSurface(h).onInspect();await storageSurface(h).onSave();assert.equal(h.calls.filter(call=>call.url==='/__cloud/ssh/inspect').length,1);assert.equal(h.calls.some(call=>call.url==='/__cloud/ssh/save'),false);
  h.el('cloudSyncDialog').close();await h.el('cloudSSHSettings').fire('click');assert.equal(storageSurface(h).draft.uncertain,true);
  job=storageJob('error','已确认失败，请检查服务器');await storageSurface(h).onRefresh();assert.equal(storageSurface(h).draft.uncertain,false);assert.equal(storageSurface(h).draft.kind,'error');
});

test('a read failure after a confirmed terminal move does not invent an unresolved migration',async t=>{
  for(const state of ['completed','error'])await t.test(state,async st=>{
    const terminal=storageJob(state,state==='completed'?'迁移已确认完成':'迁移已确认失败');let fail=false,job=terminal;
    const h=storageHarness({fetch:call=>{
      if(call.url==='/__cloud/ssh'){if(fail)throw new Error('临时状态读取失败');return sshOK({config:sshConfig,remote:storageRemote,job});}
    }});st.after(()=>h.api.destroy());await openStorage(h);
    fail=true;await storageSurface(h).onRefresh();assert.equal(storageSurface(h).draft.uncertain,false);assert.equal(storageSurface(h).draft.job.state,state);assert.equal(h.surfaces.CloudSyncOverview.blocked,false);assert.match(storageSurface(h).draft.message,/状态/);
    fail=false;job=null;await storageSurface(h).onRefresh();assert.equal(storageSurface(h).draft.uncertain,false);assert.equal(storageSurface(h).draft.job.state,state,'a backend restart does not erase the result already confirmed in this window');assert.equal(storageSurface(h).draft.message,terminal.message);
    await storageSurface(h).onInspect();assert.equal(storageSurface(h).draft.verified,true);await h.api.sync();assert.equal(h.calls.filter(call=>call.url==='/__cloud/sync').length,1);
  });
});

test('an explicit client-error rejection of a move permits correction without unknown-result lockout',async t=>{
  for(const responseStatus of [400,409])await t.test(String(responseStatus),async st=>{
    let reject=true;
    const h=storageHarness({fetch:call=>call.url==='/__cloud/ssh/move'&&reject?{ok:false,status:responseStatus,json:async()=>({ok:false,error:'目录迁移请求已拒绝，未启动任务。'})}:null});st.after(()=>h.api.destroy());await openStorage(h);await prepareMove(h);
    await storageSurface(h).onMove();assert.equal(storageSurface(h).draft.uncertain,false);assert.equal(storageSurface(h).draft.confirmed,false);assert.equal(storageSurface(h).draft.verified,false);assert.equal(h.surfaces.CloudSyncOverview.blocked,false);assert.match(storageSurface(h).draft.message,/请求已拒绝/);
    await storageSurface(h).onInspect();storageSurface(h).onChange('destination','/home/fixture/corrected-cloud');storageSurface(h).onChange('confirmed',true);reject=false;await storageSurface(h).onMove();
    assert.equal(h.calls.filter(call=>call.url==='/__cloud/ssh/move').length,2);assert.equal(storageSurface(h).draft.job.state,'running');assert.equal(storageSurface(h).draft.job.destination,'/home/fixture/corrected-cloud');
  });
});

test('a lost move reply is not resolved by an older terminal job for different source or destination',async t=>{
  let job=storageJob('completed','这是上次已经完成的迁移',{source:'/home/fixture/old-cloud',destination:storageRemote.dataPath});
  const h=storageHarness({fetch:call=>{
    if(call.url==='/__cloud/ssh')return sshOK({config:sshConfig,remote:storageRemote,job});
    if(call.url==='/__cloud/ssh/move')throw new Error('新迁移的提交回复丢失');
  }});t.after(()=>h.api.destroy());await openStorage(h);await prepareMove(h);await storageSurface(h).onMove();
  for(const mismatched of [job,storageJob('completed','同源旧目标',{destination:'/home/fixture/another-destination'}),storageJob('error','同目标旧来源',{source:'/home/fixture/another-source'})]){
    job=mismatched;await storageSurface(h).onRefresh();assert.equal(storageSurface(h).draft.uncertain,true);assert.equal(h.surfaces.CloudSyncOverview.blocked,true);
    await storageSurface(h).onInspect();await storageSurface(h).onSave();await h.api.sync();
  }
  assert.equal(h.calls.filter(call=>call.url==='/__cloud/ssh/inspect').length,1);assert.equal(h.calls.some(call=>call.url==='/__cloud/ssh/save'||call.url==='/__cloud/sync'),false);
  h.el('cloudSyncDialog').close();await h.el('cloudSSHSettings').fire('click');assert.equal(storageSurface(h).draft.uncertain,true,'the expected move survives closing its dialog');
  job=storageJob('completed','本次迁移已确认完成');await storageSurface(h).onRefresh();assert.equal(storageSurface(h).draft.uncertain,false);assert.equal(storageSurface(h).draft.message,job.message);assert.equal(h.surfaces.CloudSyncOverview.blocked,false);
  await h.api.sync();assert.equal(h.calls.filter(call=>call.url==='/__cloud/sync').length,1);
});


test('a retry to the same storage path cannot adopt the previous attempt receipt', async () => {
  const config={target:'fixture-host',sshPort:0,localPort:18787,remotePort:8787}, remote={dataPath:'/source',databasePath:'/source/cloud.sqlite3'};
  let job={id:'old-attempt',source:'/source',destination:'/target',state:'error',message:'此前尝试失败'};
  const h=harness({storage:true,status:connected(),fetch:call=>{
    if(call.url==='/__cloud/ssh')return sshOK({config,remote,job});
    if(call.url==='/__cloud/ssh/inspect')return sshOK({config,remote});
    if(call.url==='/__cloud/ssh/move')throw new Error('reply lost');
  }});await h.api.refresh();await h.el('cloudSSHSettings').fire('click');
  const surface=()=>h.surfaces.CloudSSHStorage;
  await surface().onInspect();surface().onChange('destination','/target');surface().onChange('confirmed',true);await surface().onMove();
  await surface().onRefresh();assert.equal(surface().draft.uncertain,true);
  job={...job,id:'new-attempt',state:'completed',message:'本次完成'};
  await surface().onRefresh();assert.equal(surface().draft.uncertain,false);assert.equal(surface().draft.job.id,'new-attempt');h.api.destroy();
});

for (const scenario of ['return to opener','user already moved focus','dialog reopened']) test(`native closing animation focus: ${scenario}`, async () => {
  const h=sshHarness();await h.api.refresh();const opener=h.el('cloudRefresh');opener.focus();await h.api.openSSHConnection();
  const dialog=h.el('cloudSyncDialog');let finish,transitioning=true;
  dialog.getAnimations=()=>[{finished:new Promise(resolve=>{finish=resolve;})}];
  opener.focus=()=>{if(!transitioning)h.doc.activeElement=opener;};
  h.doc.activeElement=h.doc.body;dialog.close();assert.equal(h.doc.activeElement,h.doc.body);
  if(scenario==='user already moved focus')h.el('cloudUsername').focus();
  if(scenario==='dialog reopened')await h.api.openSSHConnection();
  transitioning=false;finish();await tick();
  if(scenario==='return to opener')assert.equal(h.doc.activeElement,opener);
  else if(scenario==='user already moved focus')assert.equal(h.doc.activeElement,h.el('cloudUsername'));
  else assert.notEqual(h.doc.activeElement,opener);
  h.api.destroy();
});

test('maintenance mouse entry focuses the clicked Kit opener before native showModal records its prior focus', async t => {
  let priorFocus;
  const h=storageHarness({onShowModal:active=>{priorFocus=active;}});t.after(()=>h.api.destroy());await h.api.refresh();await tick();
  const input=h.doc.createElement('input');input.value='synthetic embedding model';h.doc.body.append(input);input.focus();
  const opener=h.doc.createElement('button');opener.id='kit-maintenance-entry';h.el('cloudSyncCard').append(opener);
  await h.surfaces.CloudSyncOverview.onSSHStorage({currentTarget:opener});
  assert.equal(priorFocus,opener,'WebKit must capture the clicked button instead of the previously focused text field');
  assert.equal(input.value,'synthetic embedding model');assert.equal(h.calls.some(call=>call.method==='POST'),false);
  h.el('cloudSyncDialog').close();await tick();assert.equal(h.doc.activeElement,opener);
});

for(const unavailable of ['hidden','detached','disabled'])test(`maintenance opener fallback skips a ${unavailable} legacy control before showModal`,async t=>{
  let priorFocus;
  const h=storageHarness({onShowModal:active=>{priorFocus=active;}});t.after(()=>h.api.destroy());await h.api.refresh();await tick();
  const input=h.doc.createElement('input');input.value='synthetic retained draft';h.doc.body.append(input);input.focus();
  const legacy=h.el('cloudSSHSettings');
  if(unavailable==='hidden')legacy.getClientRects=()=>[];
  if(unavailable==='detached')legacy.isConnected=false;
  if(unavailable==='disabled')legacy.disabled=true;
  await h.surfaces.CloudSyncOverview.onSSHStorage({currentTarget:legacy});
  assert.equal(priorFocus,h.el('cloudRefresh'));assert.equal(input.value,'synthetic retained draft');
});
