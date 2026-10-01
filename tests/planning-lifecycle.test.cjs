const test = require('node:test');
const assert = require('node:assert/strict');
const Planning = require('../app/planning-workbench.js');

const fixture = () => ({ projects: [{ id: 'a', name: 'A', workspace: '日常' }, { id: 'b', name: 'B', workspace: '课程' }], tasks: [{ id: 'task', projectId: 'a', workspace: '日常', title: 'Original', status: 'todo' }] });
const values = { title: 'New task', description: 'Description', workspace: '日常', projectId: 'a', status: 'todo', priority: 'medium', startAt: '', dueAt: '2026-10-04' };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function documentFixture() {
  const nodes = new Map();
  class Dialog {
    constructor() { this.open = false; this.nodes = []; this.cancelButtons = []; }
    setAttribute() {}
    set innerHTML(html) {
      this.html = html; this.nodes.forEach(node => nodes.delete(`#${node.id}`)); this.nodes = [];
      for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const node = { id: match[2], tag: match[1], value: '', disabled: false, textContent: '', focus() { this.focused = true; } };
        this.nodes.push(node); nodes.set(`#${node.id}`, node);
      }
      this.cancelButtons = [...html.matchAll(/<button[^>]*data-planning-cancel[^>]*>/g)].map(() => ({ tag: 'button', disabled: false }));
    }
    querySelectorAll(selector) { return selector === '[data-planning-cancel]' ? this.cancelButtons : [...this.nodes.filter(node => ['input', 'select', 'textarea', 'button'].includes(node.tag)), ...this.cancelButtons]; }
    showModal() { this.open = true; }
    close() { this.open = false; this.onclose?.(); }
    remove() { this.close(); nodes.delete(`#${this.id}`); }
    escape() { let prevented = false; this.oncancel?.({ preventDefault() { prevented = true; } }); if (!prevented) this.close(); return prevented; }
  }
  return { nodes, createElement: () => new Dialog(), querySelector: selector => nodes.get(selector) || null, body: { append(dialog) { nodes.set(`#${dialog.id}`, dialog); } } };
}

function harness(save = async () => true) {
  let state = fixture(), props, mounts = 0, unmounts = 0, renders = 0, serial = 0;
  const document = documentFixture(), updates = [], toasts = [];
  const hooks = { getState: () => state, save, document, now: () => 100, uid: () => `new-${++serial}`, renderAll: () => renders++, toast: text => toasts.push(text),
    mount(host, name, initial) {
      assert.equal(host.id, 'planningCreateSurface'); assert.equal(name, 'TaskCreateForm'); props = initial; mounts++;
      return { update(patch) { updates.push(patch); props = { ...props, ...patch }; }, unmount() { unmounts++; } };
    } };
  Planning.init(hooks);
  return { document, updates, toasts, hooks, get state() { return state; }, replace(next) { state = next; }, get props() { return props; }, get mounts() { return mounts; }, get unmounts() { return unmounts; }, get renders() { return renders; },
    create() { assert.equal(Planning.createTask({ projectId: 'a' }), true); return document.querySelector('#planningCreateDialog'); },
    move() { assert.equal(Planning.moveTasks(['task'], { projectId: 'a' }), true); document.querySelector('#planningMoveWorkspace').value = '课程'; document.querySelector('#planningMoveProject').value = 'b'; return document.querySelector('#planningMoveDialog'); },
    submitMove() { return document.querySelector('#planningMoveForm').onsubmit({ preventDefault() {} }); } };
}

test('Kit create waits for durable true, keeps one island and prevents cancel, Escape and duplicate submission while pending', async () => {
  const save = deferred(), h = harness(() => save.promise), dialog = h.create(), original = h.props;
  const submitted = h.props.onSubmit(values);
  assert.equal(Planning.isBusy(), true); assert.equal(h.props.busy, true); assert.equal(dialog.open, true);
  assert.equal(h.props.onCancel(), false); assert.equal(dialog.escape(), true);
  assert.equal(await original.onSubmit(values), false); assert.equal(h.state.tasks.length, 2);
  assert.equal(h.renders, 0); assert.deepEqual(h.toasts, []);
  save.resolve(true); assert.equal(await submitted, true);
  assert.equal(Planning.isBusy(), false); assert.equal(dialog.open, false); assert.equal(h.renders, 1);
  assert.equal(h.mounts, 1); assert.equal(h.unmounts, 1);
  assert.ok(h.updates.every(patch => Object.keys(patch).every(key => ['busy', 'error'].includes(key))));
  assert.equal(original.initial.title, ''); assert.equal(original.initial.projectId, 'a');
});

test('false, absent and undefined save receipts fail closed, retain the form and only roll back the exact new task', async () => {
  for (const save of [async () => false, async () => undefined, null]) {
    const h = harness(save), dialog = h.create();
    assert.equal(await h.props.onSubmit(values), false);
    assert.equal(h.state.tasks.length, 1); assert.equal(dialog.open, true); assert.equal(h.props.busy, false);
    assert.match(h.props.error, /尚未确认保存/); assert.equal(h.renders, 0); assert.deepEqual(h.toasts, []);
    assert.equal(Planning.isBusy(), false); h.props.onCancel();
  }
});

test('failed creation preserves unrelated concurrent changes and allows a safe retry without remounting inputs', async () => {
  const pending = deferred(), h = harness(() => pending.promise); h.create();
  const submission = h.props.onSubmit(values);
  h.state.tasks[0].title = 'Concurrent original update'; h.state.tasks.push({ id: 'other', title: 'Other writer' });
  pending.reject(new Error('Database offline')); assert.equal(await submission, false);
  assert.deepEqual(h.state.tasks.map(task => task.id), ['task', 'other']); assert.equal(h.state.tasks[0].title, 'Concurrent original update');
  assert.match(h.props.error, /Database offline/); assert.equal(h.mounts, 1);
  h.hooks.save = async () => true; assert.equal(await h.props.onSubmit(values), true);
  assert.equal(h.state.tasks.filter(task => task.title === values.title).length, 1);
});

test('changed created records are never rolled back over another writer and cannot be duplicated by retry', async () => {
  const pending = deferred(), h = harness(() => pending.promise); h.create(); const submission = h.props.onSubmit(values);
  h.state.tasks[1].title = 'Another writer changed it'; pending.reject(new Error('Failed'));
  assert.equal(await submission, false); assert.equal(h.state.tasks.length, 2); assert.equal(h.state.tasks[1].title, 'Another writer changed it');
  assert.equal(await h.props.onSubmit(values), false); assert.equal(h.state.tasks.length, 2); h.props.onCancel();
});

test('create revalidates destination and old owner or closed-form callbacks cannot submit into a new workspace', async () => {
  const h = harness(); h.state.projects.push({ id: 'secret', name: 'SECRET PROJECT', workspace: '日常', provenance: { origin: { private: true } } });
  h.create(); const old = h.props;
  assert.ok(!h.props.projects.some(project => project.id === 'secret'));
  h.state.projects[0].private = true; assert.equal(await old.onSubmit(values), false); assert.equal(h.state.tasks.length, 1);
  assert.match(h.props.error, /目标项目/);
  h.replace(fixture()); assert.equal(await old.onSubmit(values), false); assert.equal(h.state.tasks.length, 1);
  old.onCancel(); h.create(); assert.equal(await old.onSubmit(values), false); assert.equal(h.state.tasks.length, 1); h.props.onCancel();
});

test('late create success and failure cannot close, refresh or notify a replaced state owner', async () => {
  for (const success of [true, false]) {
    const pending = deferred(), h = harness(() => pending.promise), dialog = h.create(); const oldState = h.state;
    const submission = h.props.onSubmit(values), updates = h.updates.length;
    h.replace(fixture()); if (success) pending.resolve(true); else pending.reject(new Error('Old workspace failure'));
    assert.equal(await submission, false); assert.equal(h.state.tasks.length, 1); assert.equal(oldState.tasks.length, 2);
    assert.equal(h.updates.length, updates); assert.equal(h.renders, 0); assert.deepEqual(h.toasts, []); assert.equal(dialog.open, true);
    h.props.onCancel();
  }
});

test('invalid create values and chronology never mutate state or invoke persistence', async () => {
  let saves = 0; const h = harness(async () => { saves++; return true; }); h.create();
  for (const input of [null, { ...values, title: 4 }, { ...values, startAt: '2026-10-05' }, { ...values, dueAt: '2026-02-30' }]) assert.equal(await h.props.onSubmit(input), false);
  assert.equal(saves, 0); assert.equal(h.state.tasks.length, 1); h.props.onCancel();
});

test('a queued native close event from the previous form cannot retire a newly reopened Kit island', async () => {
  const h = harness(), dialog = h.create(), previousClose = dialog.close.bind(dialog);
  dialog.close = () => { dialog.open = false; };
  h.props.onCancel(); assert.equal(h.unmounts, 1);
  h.create(); const reopened = h.props; dialog.onclose();
  assert.equal(h.unmounts, 1); assert.equal(dialog.open, true);
  dialog.close = previousClose;
  assert.equal(await reopened.onSubmit(values), true); assert.equal(h.state.tasks.length, 2);
});

test('move waits for durable receipt and blocks both cancel controls and Escape until it settles', async () => {
  const pending = deferred(), h = harness(() => pending.promise), dialog = h.move(); const submission = h.submitMove();
  assert.equal(Planning.isBusy(), true); assert.equal(dialog.escape(), true); dialog.cancelButtons[0].onclick(); assert.equal(dialog.open, true);
  assert.equal(await h.submitMove(), false); assert.equal(h.renders, 0);
  pending.resolve(true); assert.equal(await submission, true); assert.equal(h.state.tasks[0].projectId, 'b'); assert.equal(dialog.open, false); assert.equal(Planning.isBusy(), false);
});

test('move failure restores only untouched ownership fields including originally absent keys', async () => {
  const pending = deferred(), h = harness(() => pending.promise), dialog = h.move(); const submission = h.submitMove();
  h.state.tasks[0].title = 'Concurrent title'; pending.reject(new Error('Disk full'));
  assert.equal(await submission, false); assert.equal(h.state.tasks[0].projectId, 'a'); assert.equal(h.state.tasks[0].title, 'Concurrent title');
  assert.equal(Object.hasOwn(h.state.tasks[0], 'project'), false); assert.equal(Object.hasOwn(h.state.tasks[0], 'updatedAt'), false);
  assert.equal(dialog.open, true); assert.match(h.document.querySelector('#planningMoveError').textContent, /Disk full/);
  assert.equal(h.document.querySelector('#planningMoveSubmit').disabled, false); dialog.close();
});

test('move rollback never overwrites concurrent ownership and callbacks from closed or replaced owners are inert', async () => {
  const pending = deferred(), h = harness(() => pending.promise), dialog = h.move(), callback = h.document.querySelector('#planningMoveForm').onsubmit;
  const submission = h.submitMove(); h.state.tasks[0].workspace = '科研'; pending.reject(new Error('Failure'));
  assert.equal(await submission, false); assert.equal(h.state.tasks[0].workspace, '科研');
  assert.equal(await callback({ preventDefault() {} }), false); dialog.close();
  h.replace(fixture()); assert.equal(await callback({ preventDefault() {} }), false); assert.equal(h.state.tasks[0].projectId, 'a');
});

test('move stale owner before submission or while saving does not mutate the replacement or report success', async () => {
  const early = harness(); const earlyDialog = early.move(); early.replace(fixture());
  assert.equal(await early.submitMove(), false); assert.equal(early.state.tasks[0].projectId, 'a'); earlyDialog.close();
  const pending = deferred(), h = harness(() => pending.promise), dialog = h.move(); const submission = h.submitMove();
  h.replace(fixture()); pending.resolve(true); assert.equal(await submission, false);
  assert.equal(h.state.tasks[0].projectId, 'a'); assert.equal(h.renders, 0); assert.deepEqual(h.toasts, []); dialog.close();
});
