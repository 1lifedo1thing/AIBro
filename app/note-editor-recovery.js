/* Coordinates private local draft slots without publishing a note or a model call. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NoteEditorRecovery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  const fields = ['id', 'base', 'originalTitle', 'originalContent', 'originalFolderPath', 'title', 'content', 'folderPath', 'appliedAiDraft', 'retainedDraft'];
  const snapshot = value => value ? Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])) : null;
  const equal = (a, b) => a === b || !!a && !!b && fields.every(key => a[key] === b[key]);
  function create(hooks, env = globalThis) {
    if (!env.NoteDraftStore || typeof env.fetch !== 'function') return null;
    const slots = new Map();
    let active = null, island = null, host = null, epoch = 0, confirming = false;
    async function request(path, options = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await env.fetch(path, { ...options, signal: controller.signal, credentials: 'same-origin' });
        const result = await response.json();
        if (!response.ok) throw Object.assign(new Error(result.message || result.error || '本机草稿保存失败。'), { code: result.code });
        return result;
      } finally { clearTimeout(timer); }
    }
    function slotFor(id) {
      if (slots.has(id)) return slots.get(id);
      const slot = { id, initialized: false, status: { state: 'loading' }, last: null, hasDraft: false, touched: false, cleanup: false, restored: false, loading: false, promise: null, localConflict: false, accepted: false, result: null, sequence: 0, clearing: 0, releaseReady: false };
      slots.set(id, slot);
      slot.store = env.NoteDraftStore.create({ id, request, crypto: env.crypto, onStatus(value) {
        slot.status = value;
        if (active === slot) render();
      } });
      return slot;
    }
    function releaseInactive(slot) {
      // A recovery acknowledgement is not a formal note save. Retain dirty,
      // failed or in-flight slots until a committed note's cleanup also wins.
      if (!slot || active === slot || slots.get(slot.id) !== slot || !slot.releaseReady ||
          slot.loading || slot.promise || slot.clearing || slot.localConflict || slot.hasDraft ||
          slot.touched || slot.cleanup || slot.store.hasPending() || ['error', 'conflict', 'unavailable'].includes(slot.status.state)) return;
      const session = hooks.getSession?.();
      if (session?.id === slot.id && hooks.dirty(session)) return;
      slots.delete(slot.id);
      slot.store.dispose();
      slot.result = null; slot.last = null;
    }
    function props(slot) {
      return { ...slot.status, state: slot.loading ? 'loading' : slot.localConflict ? 'conflict' : slot.status.state,
        message: slot.localConflict ? '本机还有另一份草稿。当前编辑未覆盖它，可复制当前内容或载入本机草稿。' : slot.status.message,
        restored: slot.restored, cleanupPending: slot.cleanup, confirmReplace: confirming, busy: slot.loading,
        onRetry: () => retry(slot), onCopy: () => copy(slot), onReload: () => { confirming = true; render(); },
        onCancelReload: () => { confirming = false; render(); }, onConfirmReload: () => reload(slot) };
    }
    function render() {
      if (!active || !host) return;
      if (island) island.update(props(active));
      else if (env.HalaskaUI?.mount) island = env.HalaskaUI.mount(host, 'NoteDraftRecovery', props(active));
      else host.textContent = active.cleanup ? '笔记已保存，恢复草稿尚未清理。' : active.status.message || '';
    }
    function setLoading(slot, value) {
      slot.loading = value;
      if (active === slot) { hooks.onLoading?.(value); render(); }
    }
    function fail(slot, error) {
      slot.status = { ...slot.status, state: 'error', message: error?.message || '本机草稿保存失败。当前内容仍保留在编辑器中。' };
      if (active === slot) render();
      return false;
    }
    function remember(session) {
      if (!session || session.retainedDraft) return;
      const slot = slots.get(session.id);
      if (!slot || !slot.initialized || slot.loading || slot.localConflict) return;
      let needsDraft = hooks.dirty(session);
      if (!needsDraft && slot.hasDraft) {
        try { needsDraft = hooks.begin(hooks.getState(), session.id).base !== session.base; }
        catch (_) { needsDraft = true; }
      }
      if (needsDraft) {
        const value = snapshot(session);
        if (equal(slot.last, value)) return;
        slot.sequence++; slot.last = value; slot.touched = true; slot.hasDraft = true; slot.cleanup = false; slot.releaseReady = false;
        slot.store.schedule(value);
      } else if (slot.hasDraft && !slot.cleanup && (slot.touched || slot.restored)) {
        slot.sequence++; slot.last = null; slot.hasDraft = false; slot.touched = true; slot.releaseReady = false;
        slot.store.schedule(null);
      }
    }
    async function restore(slot, result, before, force, generation) {
      slot.initialized = true; slot.result = result; slot.hasDraft = !!result.session; slot.releaseReady = false;
      let baseline;
      try { baseline = hooks.begin(hooks.getState(), slot.id); }
      catch (error) { return fail(slot, error); }
      const current = active === slot ? hooks.getSession?.() : null;
      // Navigation or input can race an asynchronous read/hash. Persisted text
      // stays available, but an old callback never changes the new editor.
      if (active !== slot || epoch !== generation || !current || current.id !== slot.id) {
        if (before && hooks.dirty(before)) slot.localConflict = true;
        return !slot.localConflict;
      }
      if (!equal(snapshot(current), before)) { slot.localConflict = true; return false; }
      if (force) slot.localConflict = false;
      if (!force && hooks.dirty(current)) {
        if (result.session) { slot.localConflict = true; return false; }
        slot.localConflict = false; slot.last = null; slot.accepted = true; return true;
      }
      if (!result.session) {
        slot.last = null; slot.restored = false; slot.cleanup = false;
        slot.accepted = true;
        if (force) hooks.onRestore?.(null);
        return true;
      }
      const savedSession = { ...result.session, base: hooks.normalizeBase ? hooks.normalizeBase(result.session.base) : result.session.base };
      const restored = await slot.store.hydrate(savedSession, baseline.base, { legacyBases: hooks.legacyBases?.(hooks.getState(), slot.id) || [] });
      if (active !== slot || epoch !== generation || !equal(snapshot(hooks.getSession?.()), before)) return false;
      // A final-note commit may have succeeded before its draft cleanup failed.
      // An identical body is not an unsaved edit to restore on the next launch.
      if (restored.title === baseline.title && restored.content === baseline.content && (restored.folderPath || '') === (baseline.folderPath || '') && !restored.appliedAiDraft) {
        slot.cleanup = true;
        const cleared = await slot.store.clear();
        if (cleared) { slot.hasDraft = false; slot.cleanup = false; slot.last = null; slot.accepted = true; slot.releaseReady = true; }
        return cleared;
      }
      slot.accepted = true; slot.last = snapshot(restored); slot.restored = true; slot.cleanup = false; slot.localConflict = false;
      hooks.onRestore?.(restored);
      return true;
    }
    function mount(element, id) {
      unmount(); host = element; active = slotFor(id); confirming = false;
      const slot = active, generation = epoch;
      render();
      if (slot.initialized && slot.accepted) { hooks.onLoading?.(false); remember(hooks.getSession?.()); return Promise.resolve(true); }
      const before = snapshot(hooks.getSession?.());
      setLoading(slot, true);
      const task = (async () => {
        try { return await restore(slot, slot.result || await slot.store.load(), before, false, generation); }
        catch (error) { slot.initialized = true; return fail(slot, error); }
        finally {
          if (slot.promise === task) { slot.promise = null; setLoading(slot, false); }
          if (active === slot && epoch === generation) { remember(hooks.getSession?.()); render(); }
          releaseInactive(slot);
        }
      })();
      slot.promise = task;
      return task;
    }
    async function reload(slot) {
      if (slot !== active || slot.loading) return false;
      const before = snapshot(hooks.getSession?.()), generation = epoch;
      confirming = false; slot.accepted = false; slot.result = null; slot.localConflict = true; setLoading(slot, true);
      try {
        const result = await slot.store.reload();
        return await restore(slot, result, before, true, generation);
      } catch (error) { return fail(slot, error); }
      finally { setLoading(slot, false); releaseInactive(slot); }
    }
    async function copy(slot) {
      const session = hooks.getSession?.();
      if (active !== slot || !session || session.id !== slot.id) return false;
      try {
        if (!env.navigator?.clipboard?.writeText) throw new Error('无法访问剪贴板，请在正文编辑框中全选复制。');
        await env.navigator.clipboard.writeText(`# ${session.title || ''}\n\n${session.content || ''}`);
        hooks.notice?.('已复制当前草稿。'); return true;
      } catch (error) { hooks.notice?.(error.message); return false; }
    }
    async function clear(id, cleanup) {
      const slot = slots.get(id);
      if (!slot) return true;
      slot.clearing++; slot.releaseReady = false;
      try {
        if (slot.promise) await slot.promise;
        slot.cleanup = cleanup;
        const generation = slot.sequence;
        if (slot.localConflict) { render(); return false; }
        const cleared = await slot.store.clear();
        if (generation !== slot.sequence) return false;
        if (cleared) { slot.last = null; slot.touched = false; slot.hasDraft = false; slot.restored = false; slot.cleanup = false; slot.accepted = true; slot.result = null; slot.releaseReady = cleanup; if (cleanup) hooks.onCleared?.(id); }
        if (active === slot) render();
        return cleared;
      } catch (error) { return fail(slot, error); }
      finally { slot.clearing--; releaseInactive(slot); }
    }
    async function retry(slot) {
      if (slot.loading || slot.localConflict) return false;
      if (slot.cleanup) return clear(slot.id, true);
      if (active === slot) remember(hooks.getSession?.());
      if (!slot.touched && !slot.store.hasPending() && active === slot) return reload(slot);
      try { return await slot.store.flush({ retry: true }); }
      catch (error) { return fail(slot, error); }
    }
    async function flushAll() {
      remember(hooks.getSession?.());
      let okay = true;
      for (const slot of slots.values()) {
        if (slot.promise) await slot.promise;
        if (active === slot) remember(hooks.getSession?.());
        if (slot.localConflict) { okay = false; continue; }
        if (!slot.touched && !slot.cleanup && !slot.store.hasPending()) continue;
        try { if (!(slot.cleanup ? await clear(slot.id, true) : await slot.store.flush({ retry: true }))) okay = false; }
        catch (error) { fail(slot, error); okay = false; }
      }
      return okay;
    }
    function unmount() { const previous = active; epoch++; island?.unmount(); island = null; host = null; active = null; confirming = false; releaseInactive(previous); }
    return { mount, unmount, remember, saved: id => clear(id, true), discard: id => clear(id, false), flushAll };
  }
  return { create };
});
