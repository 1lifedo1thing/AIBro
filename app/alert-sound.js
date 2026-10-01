(function(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AlertSound = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';
  // 按事件类型区分的提示音：全部由振荡器现场合成，不引入音频文件。
  const tones = {
    done: { label: '执行完成', notes: [[880, 0, 0.13], [1174.66, 0.12, 0.2]] },
    attention: { label: '需要你处理', notes: [[987.77, 0, 0.14], [987.77, 0.18, 0.14], [1318.51, 0.38, 0.22]] },
    failed: { label: '执行未完成', notes: [[659.25, 0, 0.16], [493.88, 0.16, 0.26]] },
    task: { label: '定时任务完成', notes: [[587.33, 0, 0.12], [880, 0.11, 0.18]] }
  };
  const DEFAULTS = { enabled: true, done: true, attention: true, failed: true, task: true };

  function preferences(value) {
    const source = value && typeof value === 'object' ? value : {};
    const out = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) if (typeof source[key] === 'boolean') out[key] = source[key];
    return out;
  }

  // 只在用户已经切到其他应用时提示；正在看的窗口不再出声。
  function shouldPlay(prefs, kind, hidden) {
    const settings = preferences(prefs);
    if (!settings.enabled) return false;
    if (!Object.hasOwn(tones, kind)) return false;
    if (settings[kind] !== true) return false;
    return hidden === true;
  }

  let hooks = {}, context = null, unlocked = false;

  function ensureContext() {
    if (context) return context;
    const Ctor = root.AudioContext || root.webkitAudioContext;
    if (!Ctor) return null;
    try { context = new Ctor(); } catch (_) { context = null; }
    return context;
  }

  function unlock() {
    const ctx = ensureContext();
    if (!ctx) return;
    unlocked = true;
    if (ctx.state === 'suspended') ctx.resume?.().catch(() => {});
  }

  function play(kind) {
    try {
      if (!shouldPlay(hooks.getPreferences?.(), kind, hooks.hidden?.())) return false;
      const ctx = ensureContext();
      if (!ctx || !unlocked || ctx.state === 'suspended') return false;
      const tone = tones[kind];
      const start = ctx.currentTime + 0.01;
      for (const [frequency, offset, duration] of tone.notes) {
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.type = 'sine'; osc.frequency.value = frequency;
        const at = start + offset;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.16, at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(at); osc.stop(at + duration + 0.02);
      }
      return true;
    } catch (_) { return false; }
  }

  function merge(current, patch) {
    const next = preferences(current);
    const source = patch && typeof patch === 'object' ? patch : {};
    // 增量更新只接受布尔值：非法字段被忽略，而不是把该项重置回默认。
    for (const key of Object.keys(DEFAULTS)) if (typeof source[key] === 'boolean') next[key] = source[key];
    return next;
  }

  function update(patch) {
    const state = hooks.getState?.();
    if (!state) return preferences();
    state.settings ||= {};
    state.settings.soundAlerts = merge(state.settings.soundAlerts, patch);
    hooks.save?.();
    return state.settings.soundAlerts;
  }

  function sync() {
    const prefs = preferences(hooks.getState?.()?.settings?.soundAlerts);
    for (const box of root.document?.querySelectorAll?.('[data-sound-kind]') || []) box.checked = prefs[box.dataset.soundKind] !== false;
    return prefs;
  }

  function attach() {
    // 浏览器要求音频在用户手势之后才能启动；这里在首次交互时解锁一次。
    const once = () => { unlock(); root.document?.removeEventListener?.('pointerdown', once, true); root.document?.removeEventListener?.('keydown', once, true); };
    root.document?.addEventListener?.('pointerdown', once, true);
    root.document?.addEventListener?.('keydown', once, true);
    root.document?.addEventListener?.('change', event => {
      const box = event.target?.closest?.('[data-sound-kind]');
      if (!box) return;
      update({ [box.dataset.soundKind]: !!box.checked });
    });
  }

  function init(options) {
    hooks = options || {};
    attach();
    return sync();
  }

  return { init, play, update, unlock, sync, preferences, merge, shouldPlay, tones, DEFAULTS };
});
