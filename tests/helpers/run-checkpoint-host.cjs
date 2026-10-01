const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const RunCheckpoint = require('../../app/run-checkpoint');

// Load the production host adapter and controller. Only persistence and the
// existing harness's rendering/platform boundaries are supplied by the test.
module.exports = function installRunCheckpointHost(context) {
  const source = fs.readFileSync(require.resolve('../../app/app.js'), 'utf8');
  const section = (start, end) => {
    const from = source.indexOf(start), to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `Run checkpoint host source: ${start}`);
    return source.slice(from, to);
  };
  context.RunCheckpoint = context.window.RunCheckpoint = RunCheckpoint;
  for (const [name, value] of Object.entries({ serverConflict: false, storageHydrated: true, activeRunId: null })) {
    if (!(name in context)) context[name] = value;
  }
  const snapshots = [];
  let persist = context.saveDocumentDurably || (() => true);
  context.saveDocumentDurably = async () => {
    const snapshot = structuredClone(context.state);
    snapshots.push(snapshot);
    return persist(snapshot);
  };
  vm.runInContext([
    section('let runCheckpointController =', '\nfunction approvalBusy('),
    section('function refreshApprovalUI(', '\nfunction approvalError('),
  ].join('\n'), context);
  return { snapshots, setPersist: callback => { persist = callback; } };
};
