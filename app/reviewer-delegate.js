(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReviewerDelegate = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 审查者代批（T4）：把「谁审批」从「批什么」里解耦出来。
  //
  // 边界由 WorkstationPermissionPolicy 决定且完全不因本模块而变化：
  //   1) 动作必须本来就被 needsApproval() 判定为需要审批（本模块无权创造新权限）；
  //   2) 动作必须是本应用自己的事务型动作，且非破坏性（不可逆动作永远由人点头）；
  //   3) 归属确认（routingReview）不由审查者代批。
  // 本模块只回答：拿到审查者意见后，宿主该做什么。
  //
  // 三种去向：
  //   approve  → 代批并执行（审查者明确建议批准）
  //   handback → 交回人（谨慎 / 建议不要批准 / 未给出结论——有疑虑就不自动推进）
  //   halt     → 停止自动推进（连续被拒达上限，防止模型反复提出被拒方案空转）
  const DENIAL_LIMIT = 3;

  function decide({ verdict, denials = 0 } = {}) {
    const seen = Math.max(0, Number(denials) || 0);
    if (verdict === 'approve') return { action: 'approve', denials: 0, reason: 'approve' };
    if (verdict === 'reject') {
      const next = seen + 1;
      return next >= DENIAL_LIMIT
        ? { action: 'halt', denials: next, reason: 'denial-limit' }
        : { action: 'handback', denials: next, reason: 'rejected' };
    }
    // caution 与“未给出结论”一律交回人：自动化不在这里替人壮胆。
    return { action: 'handback', denials: seen, reason: verdict === 'caution' ? 'caution' : 'inconclusive' };
  }

  // 审查者不可用时（调用失败 / 读取凭据失败）：退回人工审批，且不改变任何计数。
  function fallbackNote(error) {
    const detail = String(error || '').trim().slice(0, 160);
    return detail
      ? `审查者代批未生效（${detail}），已交回你决定。`
      : '审查者代批未生效，已交回你决定。';
  }

  function noteFor(decision, { auto = false } = {}) {
    if (!decision) return '';
    if (decision.action === 'approve') return '审查者已代为批准这批动作（边界未变：动作类型与范围仍受原审批策略约束）。';
    if (decision.action === 'halt') return `审查者已连续 ${decision.denials} 次不建议执行，自动推进已停止，请人工检查目标或调整方案。`;
    if (decision.reason === 'caution') return '审查者建议谨慎，已交回你决定。';
    if (decision.reason === 'rejected') return `审查者建议不要执行，已交回你决定（连续被拒 ${decision.denials} 次）。`;
    return '审查者未给出明确结论，已交回你决定。';
  }

  return Object.freeze({ DENIAL_LIMIT, decide, noteFor, fallbackNote });
}));
