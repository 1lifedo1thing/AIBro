/* Note drafts share the comparison draft CAS transport, with per-note routing
 * and compact version fingerprints. No unacknowledged text is called saved. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./comparison-draft-store.js'), root);
  else root.NoteDraftStore = factory(root.ComparisonDraftStore, root);
})(typeof globalThis !== 'undefined' ? globalThis : this, (ComparisonDraftStore, root) => {
  'use strict';
  const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
  const fingerprint = /^sha256:[a-f0-9]{64}$/;
  const fields = ['id', 'base', 'originalTitle', 'originalContent', 'originalFolderPath', 'title', 'content', 'folderPath', 'appliedAiDraft', 'retainedDraft'];
  const failures = new Set(['error', 'conflict', 'unavailable']);
  function hasher(crypto) {
    const cache = new Map();
    let tail = Promise.resolve();
    const hash = base => {
      if (typeof base !== 'string') return Promise.reject(new Error('Invalid note draft base'));
      if (fingerprint.test(base)) return Promise.resolve(base);
      if (cache.has(base)) return cache.get(base);
      const task = tail.then(async () => {
        if (!crypto?.subtle?.digest) throw new Error('Secure note draft hashing is unavailable.');
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(base));
        const bytes = new Uint8Array(digest);
        if (bytes.length !== 32) throw new Error('Invalid note draft fingerprint');
        return 'sha256:' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      });
      tail = task.catch(() => {});
      cache.set(base, task);
      // A note's original base can contain its revision history. Keep only two
      // bases rather than retaining a new full history after every saved edit.
      while (cache.size > 2) cache.delete(cache.keys().next().value);
      task.catch(() => { if (cache.get(base) === task) cache.delete(base); });
      return task;
    };
    hash.clear = () => cache.clear();
    return hash;
  }
  function create({ id, request, onStatus = () => {}, crypto = root.crypto, delay = 250 }) {
    if (typeof id !== 'string' || !id || typeof request !== 'function') throw new Error('A note id and draft request function are required.');
    if (!ComparisonDraftStore?.create) throw new Error('ComparisonDraftStore must be loaded before NoteDraftStore.');
    const route = '/__note-draft?id=' + encodeURIComponent(id), hash = hasher(crypto);
    let sequence = 0, desired = null, timer = null, writing = null, reading = null, readSequence = null, disposed = false;
    let status = { state: 'unavailable' }, dispatched = null, wakeEncoding = null;
    const superseded = Symbol('superseded');
    const publish = next => { status = { ...status, ...next }; if (!disposed) onStatus({ ...status }); };
    const core = ComparisonDraftStore.create({
      // The adapter owns debounce and async encoding. The core only owns the
      // already encoded, serial CAS writes and lost-acknowledgement recovery.
      delay: 2147483647,
      request: async (_, options) => {
        const before = readSequence;
        const result = await request(route, options);
        if (options.method !== 'POST' && before !== null && sequence !== before) throw new Error('Draft input changed while loading. Retry local save.');
        return result;
      },
      onStatus: next => {
        // An older write may finish while a newer input still needs hashing.
        // Its acknowledgement cannot make that newer text appear durable.
        publish(desired && desired.id !== dispatched && !failures.has(next.state) ? { ...next, state: 'saving' } : next);
      }
    });
    function cancelTimer() { if (timer) clearTimeout(timer); timer = null; }
    function schedule(value) {
      if (disposed) return;
      if (value !== null && (!value || value.id !== id)) throw new Error('Note draft belongs to a different note.');
      desired = { id: ++sequence, value: clone(value) };
      wakeEncoding?.();
      cancelTimer();
      if (failures.has(status.state)) return;
      publish({ state: 'saving', message: '' });
      timer = setTimeout(() => { timer = null; void flush(); }, delay);
    }
    async function encode(value) {
      if (value === null) return null;
      const session = Object.fromEntries(fields.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]]));
      session.base = await hash(session.base);
      return session;
    }
    async function hydrate(session, currentBase, { legacyBases = [] } = {}) {
      if (!session) return null;
      if (session.id !== id) throw new Error('Note draft belongs to a different note.');
      const value = clone(session);
      if (fingerprint.test(value.base)) {
        const candidates = [currentBase, ...legacyBases.filter(base => typeof base === 'string' && !fingerprint.test(base))];
        // Legacy candidates are the current note's complete old signature,
        // never a reconstruction from a draft's partial original fields.
        for (const base of candidates) {
          if (value.base === await hash(base)) { value.base = currentBase; break; }
        }
      }
      return value;
    }
    function read(kind) {
      if (disposed) return Promise.reject(new Error('Note draft store has been disposed.'));
      if (reading) return reading;
      cancelTimer();
      // Capture now, not after an outstanding write. Typing during either part
      // must not be replaced by a late load/reload result.
      const before = sequence;
      const task = (async () => {
        if (kind === 'load' && desired) throw new Error('Note draft has pending input. Use explicit reload to replace it.');
        while (writing) await writing;
        if (sequence !== before) throw new Error('Draft input changed while loading. Retry local save.');
        readSequence = before;
        try {
          const result = await core[kind]();
          if (sequence !== before) throw new Error('Draft input changed while loading. Retry local save.');
          desired = null;
          publish(core.getStatus());
          return result;
        } finally { readSequence = null; }
      })().catch(error => { publish({ state: 'unavailable', message: error.message }); throw error; });
      reading = task;
      void task.finally(() => { if (reading === task) reading = null; }).catch(() => {});
      return task;
    }
    async function pump(retry) {
      while (desired && !disposed) {
        const job = desired;
        let encoded, wake;
        try {
          // WebCrypto cannot abort a digest. Stop waiting for an obsolete one
          // so an explicit clear can commit even before that digest returns.
          const changed = new Promise(resolve => { wake = () => resolve(superseded); wakeEncoding = wake; });
          encoded = await Promise.race([encode(job.value), changed]);
        }
        catch (error) {
          if (desired?.id !== job.id) continue;
          publish({ state: 'error', message: error.message }); return false;
        } finally { if (wakeEncoding === wake) wakeEncoding = null; }
        if (disposed) return false;
        if (encoded === superseded) continue;
        if (desired?.id !== job.id) continue;
        dispatched = job.id;
        core.schedule(encoded); core.dispose();
        const saved = await core.flush({ retry });
        if (!saved) return false;
        if (desired?.id === job.id) desired = null;
      }
      return !disposed && !failures.has(status.state);
    }
    async function flush({ retry = false } = {}) {
      cancelTimer();
      if (disposed) return false;
      while (reading) { try { await reading; } catch (_) {} }
      while (writing) {
        await writing;
        if (!desired) return !failures.has(status.state);
        if (!retry && failures.has(status.state)) return false;
      }
      if (status.state === 'conflict' || (!retry && failures.has(status.state))) return false;
      if (status.blocked && desired?.value !== null) return false;
      if (!desired) return !failures.has(status.state);
      const task = pump(retry); writing = task;
      try { return await task; } finally { if (writing === task) writing = null; }
    }
    function clear() { schedule(null); return flush({ retry: true }); }
    function dispose() { disposed = true; wakeEncoding?.(); cancelTimer(); core.dispose(); hash.clear(); }
    return { load: () => read('load'), reload: () => read('reload'), schedule, flush, clear, hydrate, dispose,
      getStatus: () => ({ ...status }), hasPending: () => !!desired || !!writing || core.hasPending() };
  }
  return { create };
});
