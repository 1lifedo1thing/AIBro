/* Transient provider failures: resend a request only while nothing has been shown.
   Kept outside agent-transport.js, which deliberately has no timers (generation
   has no deadline); this module only waits between attempts. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentRetry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const MAX_RETRIES = 2, BASE_MS = 1500, MAX_WAIT_MS = 30000;
  // Rate limits, 5xx, dropped connections and empty or unfinished streams.
  // Quota, authentication, invalid requests, context overflow and protocol
  // errors are not transient and are never resent.
  const TRANSIENT = new Set(['RATE_LIMITED', 'UPSTREAM_SERVICE_ERROR', 'UPSTREAM_CONNECTION_ERROR', 'UPSTREAM_CONNECT_TIMEOUT',
    'UPSTREAM_STREAM_INTERRUPTED', 'STREAM_INCOMPLETE', 'EMPTY_RESPONSE']);
  const codeOf = error => error?.diagnostic?.code || error?.code || null;
  function retryable(error) {
    // receivedContent is set by the transport: anything already displayed would
    // be duplicated by a resend. Undefined (another transport) means unknown.
    if (!error || typeof error !== 'object' || error.receivedContent !== false) return false;
    if (error.protocolMismatch || error.diagnostic?.fallbackAttempted) return false;
    return TRANSIENT.has(codeOf(error));
  }
  function delay(retry, error, random = Math.random) {
    if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0) return Math.round(error.retryAfterMs);
    return Math.round(BASE_MS * 2 ** (retry - 1) * (0.8 + 0.4 * random()));
  }
  function sleep(ms, signal, timers = root) {
    return new Promise((resolve, reject) => {
      let id;
      const abort = () => { if (id !== undefined) timers.clearTimeout(id); reject(Object.assign(new Error('已停止本次执行'), { code: 'CANCELLED' })); };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener?.('abort', abort, { once: true });
      id = timers.setTimeout(() => { signal?.removeEventListener?.('abort', abort); resolve(); }, ms);
    });
  }
  function settle(error, retries) {
    if (!retries || !error || typeof error !== 'object') return error;
    error.retryAttempts = retries;
    if (error.diagnostic && root.RunFailureDiagnostics?.present) {
      error.diagnostic.retryAttempts = retries;
      const shown = root.RunFailureDiagnostics.present(error.diagnostic);
      if (shown) error.message = shown.description;
    } else if (typeof error.message === 'string') error.message += `（已自动重试 ${retries} 次）`;
    return error;
  }
  async function run(attempt, { signal, onRetry, maxRetries = MAX_RETRIES, wait = sleep, random } = {}) {
    for (let retry = 0; ; retry++) {
      try { return await attempt(retry); }
      catch (error) {
        if (signal?.aborted || retry >= maxRetries || !retryable(error)) throw settle(error, retry);
        const ms = delay(retry + 1, error, random);
        // A long server-requested wait is surfaced instead of silently stalling.
        if (ms > MAX_WAIT_MS) throw settle(error, retry);
        onRetry?.({ retry: retry + 1, maxRetries, delayMs: ms, code: codeOf(error), httpStatus: error.status ?? error.diagnostic?.httpStatus ?? null, error });
        await wait(ms, signal);
      }
    }
  }
  return { MAX_RETRIES, MAX_WAIT_MS, TRANSIENT, retryable, delay, sleep, run };
});
