/* Local comparison drafts use the workspace service, independent of WebView origin. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ComparisonDraftStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
  const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  function create({ request, onStatus = () => {}, delay = 250 }) {
    let revision = null, acknowledged = null, pending = null, sequence = 0, timer = null, running = null, status = { state: 'unavailable' };
    const publish = patch => { status = { ...status, ...patch }; onStatus({ ...status }); };
    function check(result) {
      if (!result || !Number.isSafeInteger(result.revision) || result.revision < 0) throw new Error('Invalid draft acknowledgement');
      return result;
    }
    async function read() { return check(await request('/__comparison-draft', { cache: 'no-store' })); }
    function adopt(result) {
      revision = result.revision; acknowledged = clone(result.session); pending = null;
      publish({ state: result.blocked ? 'unavailable' : acknowledged ? 'saved' : 'idle', updatedAt: result.updatedAt || null, message: '', blocked: result.blocked || null });
      return clone(result);
    }
    async function load() {
      const before = sequence;
      try { const result = await read(); if (sequence !== before) throw new Error('Draft input changed while loading. Retry local save.'); return adopt(result); }
      catch (error) { publish({ state: 'unavailable', message: error.message }); throw error; }
    }
    function schedule(value) {
      pending = { id: ++sequence, value: clone(value) };
      if (timer) clearTimeout(timer);
      if (['error', 'conflict', 'unavailable'].includes(status.state)) return;
      publish({ state: 'saving', message: '' });
      timer = setTimeout(() => { timer = null; void flush(); }, delay);
    }
    async function pump() {
      while (pending) {
        const job = pending, base = revision;
        if (base === null) { publish({ state: 'unavailable', message: 'Local draft storage has not been loaded.' }); return false; }
        try {
          publish({ state: 'saving', message: '' });
          const result = check(await request('/__comparison-draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: base, session: job.value }) }));
          if (result.revision !== base + 1) throw new Error('Unexpected draft revision');
          revision = result.revision; acknowledged = clone(job.value);
          if (pending?.id === job.id) pending = null;
          publish({ state: pending ? 'saving' : acknowledged ? 'saved' : 'idle', updatedAt: result.updatedAt || null, message: '', blocked: null });
        } catch (error) {
          // A response can be lost after fsync. Read once to distinguish that
          // acknowledgement from a conflicting write; never replay blindly.
          let current;
          try { current = await read(); } catch (_) {}
          if (current && !current.blocked && current.revision === base + 1 && canonical(current.session) === canonical(job.value)) {
            revision = current.revision; acknowledged = clone(job.value);
            if (pending?.id === job.id) pending = null;
            publish({ state: pending ? 'saving' : acknowledged ? 'saved' : 'idle', updatedAt: current.updatedAt || null, message: '', blocked: null });
            continue;
          }
          const conflict = error.code === 'draft_conflict' || (current && current.revision !== base);
          publish({ state: conflict ? 'conflict' : 'error', message: error.message, blocked: current?.blocked || null });
          return false;
        }
      }
      return true;
    }
    async function flush({ retry = false } = {}) {
      if (timer) { clearTimeout(timer); timer = null; }
      while (running) { await running; if (!pending) return !['error', 'conflict', 'unavailable'].includes(status.state); }
      if (status.state === 'conflict' || (!retry && ['error', 'unavailable'].includes(status.state))) return false;
      const perform = async () => {
        if (revision === null) {
          try {
            const current = await read();
            if (current.session || current.blocked) { publish({ state: 'conflict', message: 'A saved draft already exists.', blocked: current.blocked || null }); return false; }
            revision = current.revision;
          } catch (error) { publish({ state: 'unavailable', message: error.message }); return false; }
        }
        return pump();
      };
      const task = perform(); running = task;
      try { return await task; } finally { if (running === task) running = null; }
    }
    async function reload() {
      if (timer) { clearTimeout(timer); timer = null; }
      while (running) await running;
      // Fetch before replacing the current pending input: a failed read must
      // not turn an explicit conflict-resolution action into data loss.
      const before = sequence, current = await read();
      if (sequence !== before) {
        publish({ state: 'error', message: 'Draft input changed while loading. Retry local save.' });
        throw new Error('Draft input changed while loading. Retry local save.');
      }
      return adopt(current);
    }
    async function clear() { schedule(null); return flush({ retry: true }); }
    function dispose() { if (timer) clearTimeout(timer); timer = null; }
    return { load, schedule, flush, reload, clear, dispose, getStatus: () => ({ ...status }), hasPending: () => !!pending || !!running, revision: () => revision };
  }
  return { create };
});
