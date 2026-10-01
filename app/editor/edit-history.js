/* A document-session timeline of native history segments. A mode is only a
 * projection until the user edits it; switches alone never become undo steps.
 * Snapshots are engine-owned immutable states, never serialized document copies.
 * The host destroys this timeline with its two editor handles on tab eviction. */
export function create({ onTrim, maxSegments = 64, maxRetainedCharacters = 8000000 } = {}) {
  const handles = new Map(), loaded = new Map();
  let segments = [], cursor = -1, visible = null, applying = false, disposed = false;
  let trimmed = false;
  const capable = handle => ['captureHistory', 'restoreHistory', 'historyDepth', 'undo', 'redo'].every(key => typeof handle?.[key] === 'function');
  function snapshot(segment) {
    const handle = handles.get(segment.mode);
    if (loaded.get(segment.mode) !== segment) return segment.checkpoint;
    return segment.checkpoint = handle.captureHistory();
  }
  function attach(mode, handle) {
    if (disposed || !capable(handle)) return false;
    if (handles.has(mode) && handles.get(mode) !== handle) clear();
    handles.set(mode, handle); return true;
  }
  function activate(mode, value) {
    if (disposed || !handles.has(mode)) return false;
    for (const current of handles.values()) if (current.isComposing?.() || current.isImageBusy?.()) return false;
    const owner = segments[cursor]; if (owner) snapshot(owner);
    const handle = handles.get(mode), previous = loaded.get(mode);
    if (handle.isComposing?.() || handle.isImageBusy?.()) return false;
    if (previous) snapshot(previous);
    const desired = segments[cursor];
    applying = true;
    try {
      if (desired?.mode === mode && desired.checkpoint?.value === value) {
        if (previous !== desired && !handle.restoreHistory(desired.checkpoint)) return false;
        loaded.set(mode, desired);
      } else if (visible !== mode || previous || handle.getValue() !== value) {
        if (handle.setValue(value, { origin: 'history-projection', resetHistory: true }) === false) return false;
        loaded.set(mode, null);
      }
      visible = mode; return true;
    } finally { applying = false; }
  }
  function trim() {
    let characters = segments.reduce((sum, segment) => sum + segment.checkpoint.value.length, 0);
    let removed = 0;
    // Retain the active native segment (even for one very large document) and
    // all of its redo future. Only completed older segments may be released.
    while (cursor > 0 && (segments.length > maxSegments || characters > maxRetainedCharacters)) {
      const first = segments.shift(); characters -= first.checkpoint.value.length; cursor--; removed++;
      if (loaded.get(first.mode) === first) loaded.delete(first.mode);
    }
    if (removed && !trimmed) { trimmed = true; onTrim?.(); }
  }
  function changed(mode) {
    if (disposed || applying || mode !== visible) return;
    const handle = handles.get(mode); if (!handle) return;
    const checkpoint = handle.captureHistory(); if (!checkpoint) return;
    // An abandoned native redo branch may remain in an old immutable snapshot.
    // Its explicit ceiling prevents it from being resurrected across segments.
    const owner = segments[cursor];
    if (owner && loaded.get(mode) !== owner) owner.limit = owner.checkpoint.undo;
    const discarded = segments.splice(cursor + 1);
    for (const segment of discarded) if (loaded.get(segment.mode) === segment && segment.mode !== mode) loaded.delete(segment.mode);
    let segment = loaded.get(mode);
    if (!segment || segment !== owner) {
      segment = { mode, checkpoint, limit: checkpoint.undo };
      segments.push(segment); cursor = segments.length - 1; loaded.set(mode, segment);
    } else { segment.checkpoint = checkpoint; segment.limit = checkpoint.undo; }
    trim();
  }
  function move(direction, onRestore) {
    if (disposed || applying || !['undo', 'redo'].includes(direction)) return false;
    for (const handle of handles.values()) if (handle.isComposing?.() || handle.isImageBusy?.()) return false;
    const active = segments[cursor]; if (active) snapshot(active);
    let target = cursor < 0 ? 0 : cursor;
    while (target >= 0 && target < segments.length) {
      const segment = segments[target], checkpoint = segment.checkpoint;
      if (direction === 'undo' ? checkpoint.undo > 0 : checkpoint.undo < segment.limit && checkpoint.redo > 0) break;
      target += direction === 'undo' ? -1 : 1;
    }
    if (target < 0 || target >= segments.length) return false;
    const segment = segments[target], handle = handles.get(segment.mode);
    const previous = loaded.get(segment.mode); if (previous) snapshot(previous);
    const originalValue = handle.getValue(), original = handle.captureHistory(), oldCheckpoint = segment.checkpoint, oldCursor = cursor, oldVisible = visible;
    const rollback = () => {
      if (original) handle.restoreHistory(original);
      else handle.setValue(originalValue, { origin: 'history-rollback', resetHistory: true });
      if (previous) loaded.set(segment.mode, previous); else loaded.delete(segment.mode);
      segment.checkpoint = oldCheckpoint; cursor = oldCursor; visible = oldVisible;
    };
    applying = true;
    try {
      if (previous !== segment && !handle.restoreHistory(segment.checkpoint)) return false;
      loaded.set(segment.mode, segment);
      if (!handle[direction]()) { rollback(); return false; }
      segment.checkpoint = handle.captureHistory(); cursor = target; visible = segment.mode;
      onRestore?.({ mode: segment.mode, value: handle.getValue(), direction });
      return true;
    } catch (error) { rollback(); throw error; }
    finally { applying = false; }
  }
  function clear() {
    applying = true;
    try { for (const handle of handles.values()) handle.setValue(handle.getValue(), { origin: 'history-reset', resetHistory: true }); }
    finally { applying = false; }
    segments = []; cursor = -1; loaded.clear(); trimmed = false;
  }
  function dispose() { segments = []; cursor = -1; visible = null; loaded.clear(); handles.clear(); disposed = true; }
  return { attach, activate, changed, move, clear, dispose,
    snapshot: () => ({ segments: segments.length, cursor, mode: visible, trimmed }) };
}
