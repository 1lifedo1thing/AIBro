(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ArtifactProvenanceUI = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  const t = (zh, en) => root.WorkstationI18n?.getLanguage?.() === 'en' ? en : zh;
  const list = value => Array.isArray(value) ? value : [];
  // All actions resolve against a fresh projection. UI props are labels, never
  // authority to open an old/private/deleted record after an awaited decision.
  function createController(host) {
    let reference = null, variant = 'body', busy = false, notice = '';
    const project = () => reference && !host.isPrivate?.() ? host.project(host.getState(), reference, { variant }) : null;
    const view = () => ({ projection: project(), busy, notice, reference: reference && { ...reference }, variant });
    const changed = () => host.onChanged?.(view());
    function open(ref, options = {}) {
      if (busy || !ref?.id || !['note', 'paper', 'task'].includes(ref.type) || host.isPrivate?.()) return false;
      const nextVariant = options.variant === 'draft' ? 'draft' : 'body';
      const next = host.project(host.getState(), ref, { variant: nextVariant });
      if (!next?.available) { host.toast?.(next?.reason || t('这份成果已不可用。', 'This output is unavailable.')); return false; }
      reference = { type: ref.type, id: ref.id }; variant = nextVariant; notice = ''; changed(); return true;
    }
    function close() { if (busy) return false; reference = null; notice = ''; changed(); return true; }
    function resolve(action, payload) {
      const data = project(); if (!data?.available) return null;
      if (action === 'open-source') {
        const matches = [...list(data.inputs), ...list(data.related)].filter(item => item.key === payload?.key);
        if (matches.length !== 1 || !matches[0].available) return null;
        const source = matches[0];
        return { action, type: source.type, id: source.id, key: source.key, page: source.page || list(source.pages)[0] || 1 };
      }
      if (action === 'open-run' && data.origin?.runAvailable) return { action, runId: data.origin.runId };
      if (action === 'open-conversation' && data.origin?.conversationAvailable) return { action, type: 'conversation', id: data.origin.conversationId, runId: data.origin.runId, messageId: data.origin.userMessageId };
      if (action === 'open-relations' && reference.type === 'note') return { action, type: 'note', id: reference.id };
      return null;
    }
    async function act(action, payload = {}) {
      if (!reference || busy) return false;
      if (action === 'variant') {
        const next = payload.variant === 'draft' ? 'draft' : 'body', data = project();
        if (!data?.available || next === 'draft' && !data.hasDraft) return false;
        variant = next; notice = ''; changed(); return true;
      }
      const target = resolve(action, payload);
      if (!target) { notice = t('该记录已变化或不可用，已刷新来源信息。', 'This record changed or is unavailable. Source information was refreshed.'); changed(); return false; }
      busy = true; notice = ''; changed(); host.suspend?.();
      const guard = () => {
        const next = resolve(action, payload);
        return !!next && JSON.stringify(next) === JSON.stringify(target);
      };
      try {
        if (!guard() || typeof host.navigate !== 'function' || await host.navigate(target, guard) === false || !guard()) throw new Error(t('未离开当前页面；来源记录仍保留。', 'The current page remains open. Source information is retained.'));
        reference = null; host.didNavigate?.(); return true;
      } catch (error) {
        notice = project()?.available ? error?.message || t('未能打开该记录。', 'Could not open this record.') : t('这份成果已不可用。', 'This output is unavailable.');
        if (host.isPrivate?.()) reference = null;
        host.resume?.(!!reference); return false;
      } finally { busy = false; changed(); }
    }
    return { open, close, act, view, refresh: changed, isBusy: () => busy };
  }
  let controller, hooks = {}, dialog, surface, opener, suppressedClose = 0;
  function restoreFocus() {
    if (opener?.isConnected && opener.getClientRects().length && !opener.closest('[hidden],[inert]')) opener.focus({ preventScroll: true });
    opener = null;
  }
  function ensureDialog() {
    if (dialog) return;
    dialog = root.document.createElement('dialog'); dialog.id = 'artifactProvenanceDialog'; dialog.className = 'artifact-provenance-dialog'; dialog.setAttribute('aria-labelledby', 'artifactProvenanceTitle');
    surface = root.document.createElement('div'); dialog.append(surface); root.document.body.append(dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (!event.isComposing) close(); });
    dialog.addEventListener('close', () => {
      if (suppressedClose) { suppressedClose--; return; }
      if (dialog.open) return; // A queued event must not dismiss a reopened view.
      controller?.close(); root.HalaskaUI?.unmount(surface); restoreFocus();
    });
  }
  function paint(view) {
    if (!dialog?.open) return;
    if (!view.reference || hooks.isPrivate?.()) {
      suppressedClose++; dialog.close(); root.HalaskaUI?.unmount(surface); restoreFocus(); return;
    }
    root.HalaskaUI.mount(surface, 'ArtifactProvenanceSurface', { ...view, hasDraft: !!view.projection?.hasDraft,
      canOpenRelations: view.reference.type === 'note' && !!view.projection?.available && !!hooks.openRelations,
      onAction: (action, value) => action === 'close' ? close() : controller.act(action, value) });
  }
  function init(host) {
    hooks = host;
    controller = createController({ ...host, project: host.project || ((...args) => root.ArtifactProvenance.project(...args)), onChanged: paint,
      suspend: () => { if (dialog?.open) { suppressedClose++; dialog.close(); } },
      resume: reopen => { if (reopen && !dialog.open) { dialog.showModal(); } else if (!reopen) { root.HalaskaUI?.unmount(surface); opener = null; } },
      didNavigate: () => { root.HalaskaUI?.unmount(surface); opener = null; }
    });
    return controller;
  }
  function open(ref, options) {
    if (!controller || controller.isBusy()) return false;
    ensureDialog();
    if (!controller.open(ref, options)) return false;
    if (!dialog.open) { opener = root.document.activeElement; dialog.showModal(); }
    paint(controller.view()); dialog.querySelector('#artifactProvenanceClose,button:not(:disabled)')?.focus({ preventScroll: true }); return true;
  }
  function close() { if (!dialog?.open || !controller?.close()) return false; dialog.close(); return true; }
  root.document?.addEventListener('workstation-language-change', () => controller?.refresh());
  return { createController, init, open, close, refresh: () => controller?.refresh(), isOpen: () => !!dialog?.open || !!controller?.isBusy() };
});
