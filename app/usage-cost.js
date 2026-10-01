(function(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UsageCost = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';
  // 只用用户自己填写的单价估算；没有单价就什么都不显示——绝不编造价格。
  const DEFAULTS = { currency: '', input: 0, output: 0 };

  function preferences(value) {
    const source = value && typeof value === 'object' ? value : {};
    const currency = typeof source.currency === 'string' ? source.currency.trim().slice(0, 8) : '';
    const rate = key => { const number = Number(source[key]); return Number.isFinite(number) && number > 0 ? number : 0; };
    return { currency, input: rate('input'), output: rate('output') };
  }

  function configured(price) {
    const prefs = preferences(price);
    return !!prefs.currency && (prefs.input > 0 || prefs.output > 0);
  }

  function estimate(usage, price) {
    const prefs = preferences(price);
    if (!configured(prefs)) return null;
    const input = Number(usage?.input), output = Number(usage?.output), total = Number(usage?.total);
    const hasParts = Number.isFinite(input) && Number.isFinite(output) && input > 0 && output > 0;
    let amount = 0, rough = false;
    if (hasParts) {
      amount = input / 1e6 * prefs.input + output / 1e6 * prefs.output;
    } else if (Number.isFinite(total) && total > 0) {
      amount = total / 1e6 * ((prefs.input + prefs.output) / 2);
      rough = true; // 缺少输入/输出拆分时只用平均单价粗算，必须如实标注
    } else return null;
    if (!(amount > 0)) return null;
    return { amount, currency: prefs.currency, rough, oneMillionth: amount < 1e-6 };
  }

  function formatAmount(amount) {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value < 0.01) return value.toFixed(4);
    if (value < 1) return value.toFixed(3);
    if (value < 100) return value.toFixed(2);
    return value.toFixed(1);
  }

  function describe(usage, price) {
    const result = estimate(usage, price);
    if (!result) return '';
    if (result.oneMillionth) return '≈低于 ' + result.currency + formatAmount(1e-6) + '（估算）';
    return '≈' + result.currency + formatAmount(result.amount) + (result.rough ? '（粗略估算）' : '（估算）');
  }

  function hint(usage, price) {
    const result = estimate(usage, price);
    if (!result) return '';
    return result.rough
      ? '按你设置的单价的平均值，对总用量粗略估算；不是服务商账单。'
      : '按你在设置中填写的单价估算；不是服务商账单。';
  }

  let hooks = {};

  function read() {
    const currency = hooks.document?.()?.getElementById?.('usageCurrency')?.value;
    const input = hooks.document?.()?.getElementById?.('usageInputRate')?.value;
    const output = hooks.document?.()?.getElementById?.('usageOutputRate')?.value;
    const prefs = preferences({ currency, input, output });
    const state = hooks.getState?.();
    if (state?.settings) state.settings.usagePrice = prefs;
    return prefs;
  }

  function sync() {
    const prefs = preferences(hooks.getState?.()?.settings?.usagePrice);
    const doc = hooks.document?.();
    const put = (id, value) => { const node = doc?.getElementById?.(id); if (node) node.value = value === 0 ? '' : String(value); };
    const currency = doc?.getElementById?.('usageCurrency'); if (currency) currency.value = prefs.currency;
    put('usageInputRate', prefs.input);
    put('usageOutputRate', prefs.output);
    return prefs;
  }

  function init(options) {
    hooks = options || {};
    return preferences(hooks.getState?.()?.settings?.usagePrice);
  }

  return { init, read, sync, describe, hint, estimate, preferences, configured, formatAmount, DEFAULTS };
});
