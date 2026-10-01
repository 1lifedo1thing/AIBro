// Native agenda adapter. The existing workspace remains the sole note writer.
(() => {
  const canonical = value => JSON.stringify(sort(value));
  const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])])) : value;
  const deferred = reason => ({ status: 'deferred', reason });
  const failure = (reason, errorType = 'Error') => ({ status: 'error', reason, errorType });
  const errorTypes = new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'AbortError', 'QuotaExceededError']);
  // Never send arbitrary exception messages, note contents, identifiers or URLs
  // over the status channel. Known persistence reasons retain actionable meaning.
  const classify = error => {
    const type = errorTypes.has(error?.name) ? error.name : 'Error';
    switch (error?.message) {
      case '本机数据库尚未就绪': return deferred('hydrating');
      case '请先处理工作区同步冲突': return deferred('conflict');
      case '回收站正在保存，请稍后重试': return deferred('trash_paused');
      case '本机数据库暂时无法保存': return failure('storage_failed', type);
      case '与本机数据库连接中断': return failure('storage_disconnected', type);
      default: return failure('unexpected', type);
    }
  };
  let busy = false;
  const readiness = () => {
    if (typeof storageHydrated === 'undefined' || !storageHydrated) return deferred('hydrating');
    if (serverConflict) return deferred('conflict');
    if (busy || sendMessage.busy) return deferred('busy');
    if (purgeTrash.syncPaused) return deferred('trash_paused');
    return null;
  };
  const saving = () => Boolean(state._pendingLocalSave || serverSaveQueued || serverSaveInFlight);
  const saveWait = () => typeof serverSaveFailure !== 'undefined' && serverSaveFailure && !serverSaveInFlight
    ? classify({ name: 'Error', message: serverSaveFailure }) : deferred('saving');
  const agenda = n => n?.kind === '日程' && typeof n.content === 'string';
  const current = id => state.notes.find(n => n.id === id);
  const response = async (stage, operation) => {
    let result;
    try { result = await operation(); } catch (error) { result = classify(error); }
    return JSON.stringify({ version: 1, stage, ...result });
  };
  window.NativeAgendaSync = {
    read() { return response('read', async () => {
      let wait = readiness(); if (wait) return wait;
      if (saving()) await window.flushWorkspace();
      wait = readiness(); if (wait) return wait;
      if (saving()) return saveWait();
      return { status: 'ready', notes: Object.fromEntries(state.notes.filter(agenda).map(n => [n.id, canonical(n)])) };
    }); },
    write(changes) { return response('write', async () => {
      const wait = readiness(); if (wait) return wait;
      if (saving()) return saveWait();
      if (!Array.isArray(changes) || changes.length > 10000) return failure('invalid_batch');
      const replacements = [];
      for (const change of changes) {
        if (!change || typeof change.id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(change.id)) return failure('invalid_identifier');
        let expected, note;
        try {
          expected = change.expected == null ? null : canonical(JSON.parse(change.expected));
          note = JSON.parse(change.note);
          if (!agenda(note) || note.id !== change.id || JSON.parse(note.content)?.format !== 'aibro.agenda.v1') return failure('invalid_note');
        } catch (_) { return failure('invalid_note', 'SyntaxError'); }
        const old = current(change.id);
        if ((old ? canonical(old) : null) !== expected) return deferred('stale_snapshot');
        replacements.push({ id: change.id, old, note });
      }
      if (new Set(replacements.map(x => x.id)).size !== replacements.length) return failure('duplicate_identifier');
      busy = true;
      try {
        for (const {id,note} of replacements) {
          const index = state.notes.findIndex(n => n.id === id);
          if (index < 0) state.notes.push(note); else state.notes[index] = note;
        }
        try {
          if (await saveDocumentDurably() !== true) throw Error('本机数据库暂时无法保存');
        } catch (error) {
          for (const {id,old,note} of replacements) {
            const index = state.notes.findIndex(n => n.id === id);
            if (index >= 0 && state.notes[index] === note) {
              if (old) state.notes[index] = old; else state.notes.splice(index,1);
            }
          }
          try { save(); renderAll(); } catch (_) { return failure('rollback_failed'); }
          return classify(error);
        }
        // Only exact durable writes may be acknowledged. A later render failure
        // must not roll back a successfully committed note; the next read reconciles it.
        const accepted = replacements.filter(x => canonical(current(x.id)) === canonical(x.note)).map(x => x.id);
        renderAll();
        return { status: 'ready', accepted };
      } finally { busy = false; }
    }); }
  };
})();
