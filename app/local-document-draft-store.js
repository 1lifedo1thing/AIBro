/* Complete local-file recovery, separate from both disk writes and UI prefs.
 * The shared transport owns serialized CAS and lost-acknowledgement recovery;
 * this adapter owns document identity, read/input races and view lifetime. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./comparison-draft-store.js'));
  else root.LocalDocumentDrafts = factory(root.ComparisonDraftStore);
})(typeof globalThis !== 'undefined' ? globalThis : this, ComparisonDraftStore => {
  'use strict';
  const fields = ['id', 'projectId', 'candidateId', 'path', 'version', 'baseContent', 'content', 'mode', 'selection', 'scroll', 'sourceConversationId', 'recoveryContent', 'retainedDraft'];
  const failures = new Set(['error', 'conflict', 'unavailable']);
  const identity = ref => JSON.stringify([ref.projectId, ref.candidateId, ref.path]);
  function create({ ref, request, onStatus = () => {}, delay = 250 }) {
    if (!ref || ![ref.projectId, ref.candidateId, ref.path].every(value => typeof value === 'string' && value)
        || typeof request !== 'function') throw new Error('A local document identity and draft request function are required.');
    if (!ComparisonDraftStore?.create) throw new Error('ComparisonDraftStore must be loaded before LocalDocumentDrafts.');
    const id = identity(ref), route = '/__local-document-draft?id=' + encodeURIComponent(id);
    let disposed = false, sequence = 0, timer = null, reading = null, writing = null, readSequence = null;
    let status = { state: 'unavailable' }, availability = {};
    const publish = value => { status = { ...status, ...value, ...availability }; if (!disposed) onStatus({ ...status }); };
    const core = ComparisonDraftStore.create({
      delay: 2147483647,
      onStatus: publish,
      request: async (_route, options) => {
        if (disposed) throw new Error('Local document draft store has been disposed.');
        const before = readSequence;
        const result = await request(route, options);
        if (disposed) throw new Error('Local document draft store has been disposed.');
        if (options.method !== 'POST' && before !== null && sequence !== before) throw new Error('Draft input changed while loading. Retry local save.');
        availability = { recoveryOnly: !!result.recoveryOnly, unavailable: result.unavailable || null };
        return result;
      }
    });
    const cancelTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
    function schedule(value) {
      if (disposed) return;
      if (value !== null && (!value || value.id !== id || identity(value) !== id)) throw new Error('Local draft belongs to a different document.');
      // Preserve full raw strings. Whitelist excludes editor objects, DOM,
      // selections from another document and arbitrary sync/workspace data.
      const session = value === null ? null : Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
      sequence += 1;
      cancelTimer();
      core.schedule(session); core.dispose();
      if (!failures.has(status.state)) timer = setTimeout(() => { timer = null; void flush(); }, delay);
    }
    function read(kind) {
      if (disposed) return Promise.reject(new Error('Local document draft store has been disposed.'));
      if (reading) return reading;
      cancelTimer();
      const before = sequence;
      const task = (async () => {
        if (kind === 'load' && core.hasPending()) throw new Error('Local draft has pending input. Use explicit reload to replace it.');
        while (writing) await writing;
        if (disposed || sequence !== before) throw new Error('Draft input changed while loading. Retry local save.');
        readSequence = before;
        try {
          const result = await core[kind]();
          if (disposed || sequence !== before) throw new Error('Draft input changed while loading. Retry local save.');
          return result;
        } finally { readSequence = null; }
      })().catch(error => { publish({ state: 'unavailable', message: error.message }); throw error; });
      reading = task;
      void task.finally(() => { if (reading === task) reading = null; }).catch(() => {});
      return task;
    }
    async function flush({ retry = false } = {}) {
      cancelTimer();
      if (disposed) return false;
      while (reading) { try { await reading; } catch (_) {} }
      while (writing) {
        await writing;
        if (!core.hasPending()) return !disposed && !failures.has(status.state);
        if (!retry && failures.has(status.state)) return false;
      }
      if (disposed || status.state === 'conflict' || (!retry && failures.has(status.state))) return false;
      const task = core.flush({ retry }); writing = task;
      try { return await task && !disposed; } finally { if (writing === task) writing = null; }
    }
    const clear = () => { schedule(null); return flush({ retry: true }); };
    const dispose = () => { disposed = true; cancelTimer(); core.dispose(); };
    return { load: () => read('load'), reload: () => read('reload'), schedule, flush, clear, dispose,
      getStatus: () => ({ ...status }), hasPending: () => core.hasPending(), revision: () => core.revision() };
  }
  return { create, identity };
});
