const test = require('node:test');
const assert = require('node:assert/strict');
const Outcome = require('../app/run-outcome-presentation');

const guidance = '可以重试，或点击“调整附件后重试”移除有问题的附件；也可以直接在下方继续对话。';
const make = (status, error, effect = '尚未执行任何动作。') => ({
  message: { role: 'assistant', retryRunId: 'run-1', text: `${status === 'cancelled' ? '已停止本次执行' : '调用失败'}：${error}\n\n${effect}${guidance}` },
  run: { id: 'run-1', status, error },
});

test('the exact generated failure envelope moves once into the notice without mutating history', () => {
  const { message, run } = make('failed', '连接已断开');
  const before = JSON.stringify({ message, run });
  const result = Outcome.present(message, run);
  assert.equal(result.answerText, '');
  assert.equal(result.noticeDescription, '连接已断开');
  assert.equal(result.generatedFailure, true);
  assert.equal(result.showNotice, true);
  assert.equal(JSON.stringify({ message, run }), before);
  assert.doesNotMatch(result.hint, /尚未执行任何动作/);
});

test('duplicate default stop messages become one title, while meaningful stop reasons survive', () => {
  for (const error of ['已停止本次执行', '已停止本次执行。', '用户已停止本次执行。', 'Stopped']) {
    const { message, run } = make('cancelled', error);
    const result = Outcome.present(message, run);
    assert.equal(result.answerText, '');
    assert.equal(result.noticeTitle, '本次执行已停止');
    assert.equal(result.noticeDescription, '');
  }
  const { message, run } = make('cancelled', '同一个工具连续执行 5 次，已暂停。');
  assert.equal(Outcome.present(message, run).noticeDescription, run.error);
});

test('genuine answers, partial output, quoted error text and different errors are never rewritten', () => {
  const { message, run } = make('failed', '网络错误');
  for (const text of ['已读完第一章，结论如下：\n\n- A\n- B', '调用失败：网络错误\n\n但已经整理出以下内容：A', message.text + '\n模型的额外说明', message.text.replace('网络错误', '另一个错误'), '`调用失败：网络错误`', '  调用失败：网络错误  ']) {
    const result = Outcome.present({ ...message, text }, run);
    assert.equal(result.answerText, text);
    assert.equal(result.generatedFailure, false);
  }
});

test('live, user, successful, awaiting-approval and awaiting-save messages keep their answer and no failure notice', () => {
  const { message, run } = make('failed', '错误');
  for (const changed of [{ ...message, live: true }, { ...message, role: 'user' }]) {
    assert.equal(Outcome.present(changed, run).answerText, changed.text);
    assert.equal(Outcome.present(changed, run).showNotice, false);
  }
  for (const status of ['running', 'completed', 'completed-local', 'awaiting-approval', 'awaiting-save']) {
    const result = Outcome.present(message, { ...run, status });
    assert.equal(result.answerText, message.text);
    assert.equal(result.showNotice, false);
  }
});

test('the exact envelope requires a known error and retry association', () => {
  const { message, run } = make('failed', '错误');
  assert.equal(Outcome.present(message, { status: 'failed' }).answerText, message.text);
  assert.equal(Outcome.present({ ...message, retryRunId: undefined }, run).answerText, message.text);
  assert.equal(Outcome.present({ ...message, text: '调用失败：错误' }, run).answerText, '');
});

test('a recovered interruption keeps the complete partial answer but does not repeat the appended notice', () => {
  const error = '上次执行随本机服务结束而中断。已保存的输出保留，请核对后继续。';
  const run = { status: 'interrupted', error };
  const partial = '# 已得到的结果\n\n第一章…\n';
  const result = Outcome.present({ role: 'assistant', retryRunId: 'run-1', text: partial + '\n\n' + error }, run);
  assert.equal(result.answerText, partial);
  assert.equal(result.noticeDescription, error);
  const other = { role: 'assistant', retryRunId: 'run-1', text: partial + '\n\n其他中断原因' };
  assert.equal(Outcome.present(other, { ...run, error: '其他中断原因' }).answerText, other.text);
});

test('protocol diagnostics only move when explicitly substituted; raw DSML stays available to the caller', () => {
  const issue = { code: 'MODEL_PROTOCOL_ERROR', text: '模型返回了未执行的工具调用格式。' };
  const run = { status: 'failed', error: issue.text };
  const source = { role: 'assistant', retryRunId: 'run-1', text: '<|DSML|calls>原始工具协议</|DSML|calls>' };
  assert.equal(Outcome.present(source, run, { responseIssue: issue }).answerText, source.text);
  const corrected = { ...source, text: issue.text };
  assert.equal(Outcome.present(corrected, run, { responseIssue: issue }).answerText, '');
  assert.equal(Outcome.present(corrected, run, { responseIssue: issue }).noticeDescription, issue.text);
  assert.equal(Outcome.present({ ...corrected, retryRunId: undefined }, run, { responseIssue: issue }).answerText, issue.text, 'a diagnostic with no associated retry card must remain visible');
  assert.equal(source.text, '<|DSML|calls>原始工具协议</|DSML|calls>');
});

test('read-only history is acknowledged rather than falsely described as no activity', () => {
  const { message, run } = make('failed', '输出中断');
  for (const records of [{ toolCalls: [{ type: 'read_page', status: 'completed' }] }, { knowledgeReads: [{ page: 1 }] }, { knowledgeSearches: [{ query: 'A' }] }]) {
    const result = Outcome.present(message, { ...run, ...records });
    assert.match(result.hint, /工具与资料读取记录仍可查看/);
    assert.doesNotMatch(result.hint, /尚未执行任何动作|尚未执行|未修改|未写入/);
  }
});

test('terminal and browser side effects are both retained, including failed or stopped commands that started', () => {
  for (const effect of ['本轮已执行过终端命令，其效果不会自动撤销；请检查命令记录后继续。', '本轮已发生浏览器操作，其效果不会自动撤销；请核对页面与操作记录后继续。']) {
    const { message, run } = make('failed', '错误', effect);
    const result = Outcome.present(message, { ...run, commands: [{ startedAt: 100, status: 'cancelled' }], browserSession: { operationCount: 2 } });
    assert.equal(result.answerText, '');
    assert.match(result.hint, /终端命令/);
    assert.match(result.hint, /浏览器操作/);
    assert.match(result.hint, /不会自动撤销/);
  }
});

test('proposed commands do not claim to have executed and file proposals differ from possibly applied changes', () => {
  const { message, run } = make('failed', '错误');
  const pending = Outcome.present(message, { ...run, commands: [{ status: 'pending' }], localFileEdits: [{ status: 'pending' }] });
  assert.doesNotMatch(pending.hint, /已执行过终端|文件修改记录/);
  assert.match(pending.hint, /提案仍保留/);
  for (const status of ['applied', 'partial', 'applying', 'undoing', 'interrupted']) {
    assert.match(Outcome.present(message, { ...run, localFileEdits: [{ status }] }).hint, /结果或文件修改记录/);
  }
  assert.match(Outcome.present(message, { ...run, results: [{ type: 'project', id: 'existing' }] }).hint, /结果或文件修改记录/);
});

test('English chrome leaves actual provider error and partial answer untranslated and intact', () => {
  const message = { role: 'assistant', retryRunId: 'r', text: '已经分析到第二页' };
  const result = Outcome.present(message, { status: 'failed', error: '服务端关闭连接' }, { language: 'en' });
  assert.equal(result.answerText, message.text);
  assert.equal(result.noticeDescription, '服务端关闭连接');
  assert.equal(result.noticeTitle, 'This run did not finish');
  assert.match(result.hint, /Retry starts a new run/);
});

test('a browser global and CommonJS expose the same pure contract', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../app/run-outcome-presentation'), 'utf8'), context);
  assert.equal(typeof context.RunOutcomePresentation.present, 'function');
  assert.equal(context.RunOutcomePresentation.present({ text: '回答' }).answerText, '回答');
});

function withDiagnostics(present) {
  const vm = require('node:vm'), fs = require('node:fs');
  const context = vm.createContext({ RunFailureDiagnostics: { present } });
  vm.runInContext(fs.readFileSync(require.resolve('../app/run-outcome-presentation'), 'utf8'), context);
  return context.RunOutcomePresentation;
}

test('recorded diagnostics classify failed runs without changing partial answers or side-effect guidance', () => {
  const diagnostic = { category: 'authentication' };
  const calls = [];
  const Classified = withDiagnostics((value, options) => {
    calls.push({ value, options });
    return { title: '服务拒绝了身份验证', description: '请检查当前模型服务的 API Key。', action: 'settings', actionLabel: '检查模型设置', details: [{ label: 'HTTP 状态', value: '401' }] };
  });
  const message = { role: 'agent', retryRunId: 'run-1', text: '# 已收到的结果\n\n这一段不能丢。' };
  const run = { id: 'run-1', status: 'failed', error: '原来的错误', errorDiagnostic: diagnostic,
    commands: [{ startedAt: 1 }], browserSession: { operationCount: 1 }, results: [{ id: 'real-result' }] };
  const before = JSON.stringify({ message, run });
  const result = Classified.present(message, run, { language: 'en' });
  assert.equal(result.answerText, message.text);
  assert.equal(result.noticeTitle, '服务拒绝了身份验证');
  assert.equal(result.noticeDescription, '请检查当前模型服务的 API Key。');
  assert.equal(result.recoveryAction, 'settings');
  assert.equal(result.recoveryActionLabel, '检查模型设置');
  assert.equal(JSON.stringify(result.diagnosticDetails), JSON.stringify([{ label: 'HTTP 状态', value: '401' }]));
  assert.match(result.hint, /Commands ran/); assert.match(result.hint, /Browser operations/); assert.match(result.hint, /file-change records/);
  assert.match(result.hint, /Retry starts a new run/);
  assert.equal(calls.length, 1); assert.equal(calls[0].value, diagnostic); assert.equal(calls[0].options.language, 'en');
  assert.equal(JSON.stringify({ message, run }), before);
});

test('diagnostic wording is applied after precise old-envelope deduplication', () => {
  const { message, run } = make('failed', '网络错误');
  const Classified = withDiagnostics(() => ({ title: '连接未建立', description: '无法连接到模型服务。', action: null, details: [] }));
  const result = Classified.present(message, { ...run, errorDiagnostic: { category: 'network' } });
  assert.equal(result.answerText, ''); assert.equal(result.generatedFailure, true);
  assert.equal(result.noticeDescription, '无法连接到模型服务。');
  const authentic = message.text + '\n随后已获取第一章的正文。';
  assert.equal(Classified.present({ ...message, text: authentic }, { ...run, errorDiagnostic: {} }).answerText, authentic);
});

test('historical errors without recorded diagnostics stay unclassified regardless of error wording', () => {
  let calls = 0;
  const Classified = withDiagnostics(() => { calls++; return { title: 'wrong classification' }; });
  const { message, run } = make('failed', 'HTTP 502: network quota SSL invalid api key');
  const result = Classified.present(message, run);
  assert.equal(result.noticeTitle, '这次执行未完成'); assert.equal(result.noticeDescription, run.error);
  assert.equal(result.recoveryAction, null); assert.equal(result.diagnosticDetails.length, 0); assert.equal(calls, 0);
});

test('cancelled, interrupted, live and successful runs never display a stale failure classification', () => {
  let calls = 0;
  const Classified = withDiagnostics(() => { calls++; return { title: 'wrong classification', action: 'settings', actionLabel: 'wrong' }; });
  const { message, run } = make('cancelled', '已停止本次执行');
  for (const status of ['cancelled', 'interrupted', 'completed', 'awaiting-approval']) {
    const result = Classified.present(message, { ...run, status, errorDiagnostic: { category: 'network' } });
    assert.equal(result.recoveryAction, null); assert.notEqual(result.noticeTitle, 'wrong classification');
  }
  assert.equal(Classified.present({ ...message, live: true }, { ...run, status: 'failed', errorDiagnostic: {} }).showNotice, false);
  assert.equal(calls, 0);
});

test('unsupported diagnostics and unavailable diagnostic modules fall back without guessing recovery actions', () => {
  const { message, run } = make('failed', '旧错误');
  for (const classified of [Outcome, withDiagnostics(() => null)]) {
    const result = classified.present(message, { ...run, errorDiagnostic: { category: 'unknown' } });
    assert.equal(result.noticeDescription, run.error); assert.equal(result.recoveryAction, null);
    assert.equal(result.diagnosticDetails.length, 0);
  }
  const malformed = withDiagnostics(() => ({ action: 'replay', actionLabel: '执行', details: [{ label: '阶段', value: '连接' }, { label: {}, value: 'bad' }, null, { label: 'bad', value: 403 }] }));
  const result = malformed.present(message, { ...run, errorDiagnostic: {} });
  assert.equal(result.recoveryAction, null); assert.equal(result.recoveryActionLabel, '');
  assert.equal(JSON.stringify(result.diagnosticDetails), JSON.stringify([{ label: '阶段', value: '连接' }]));
});

test('context recovery is a suggested explicit action and does not imply continuation or repaired output', () => {
  const Classified = withDiagnostics(() => ({ title: '输入超出服务限制', description: '请调整本轮上下文。', action: 'context', actionLabel: '查看本轮上下文', details: [] }));
  const { message, run } = make('failed', '上下文过长');
  const result = Classified.present(message, { ...run, errorDiagnostic: {} });
  assert.equal(result.recoveryAction, 'context'); assert.equal(result.recoveryActionLabel, '查看本轮上下文');
  assert.match(result.hint, /发起新一轮执行/); assert.doesNotMatch(JSON.stringify(result), /已修复|继续上次执行|安全续跑/);
});

function protocolInspector() {
  const vm = require('node:vm'), fs = require('node:fs');
  const context = vm.createContext({ WorkstationCore: require('../app/workstation-core') });
  vm.runInContext(fs.readFileSync(require.resolve('../app/sse-frame-scanner'), 'utf8') + '\n' + fs.readFileSync(require.resolve('../app/agent-transport'), 'utf8'), context);
  return context.AgentTransport.inspectProtocolOutput;
}
const inspect = protocolInspector();

test('partial output preserves ordinary received text even though the app marks every delta as planPreview', () => {
  const rawOutput = '# 第一章\n\n已读取前两页，核心概念是 A。';
  const message = { role: 'agent', text: rawOutput, planPreview: true };
  assert.equal(Outcome.preservePartial(message, {}, { rawOutput, inspect }), rawOutput);
  assert.equal(Outcome.preservePartial(message, {}, { inspect }), '', 'a preview alone has no trustworthy source');
  assert.equal(Outcome.preservePartial({ role: 'user', text: rawOutput }, {}, { rawOutput, inspect }), '');
});

test('partial plan extraction only accepts the top-level message and keeps complete received escapes', () => {
  for (const rawOutput of ['{"message":"前半段\\n后半段', '{"workspace":"科研","actions":[],"message":"前半段\\n后半段', '{"metadata":{"message":"PRIVATE","rows":[1,{"value":"x,y}"}]},"message":"前半段\\n后半段']) {
    assert.equal(Outcome.preservePartial({ planPreview: true }, {}, { rawOutput, inspect }), '前半段\n后半段');
  }
  for (const ending of ['\\', '\\u', '\\u4', '\\u4f']) {
    assert.equal(Outcome.preservePartial({}, {}, { rawOutput: '{"message":"已有内容' + ending, inspect }), '已有内容');
  }
  assert.equal(Outcome.preservePartial({}, {}, { rawOutput: '{"message":"你好\\u4f60\\t世界"', inspect }), '你好你\t世界');
  assert.equal(Outcome.preservePartial({}, {}, { rawOutput: '{"message":"bad\\q"', inspect }), '');
});

test('nested tool message values and unfinished internal structures never become public partial answers', () => {
  for (const rawOutput of ['{"knowledgeRequests":[{"type":"browser_type","message":"PRIVATE"}]}', '{"actions":[{"message":"PRIVATE"}],"workingSummary":"INTERNAL"}', '{"tool":{"message":"PRIVATE"', '[{"message":"PRIVATE"}]', '{"message":{"text":"PRIVATE"}}', '{"message":42}', '{"bad":oops,"message":"PRIVATE"}']) {
    assert.equal(Outcome.preservePartial({ text: 'PRIVATE', planPreview: true }, {}, { rawOutput, inspect }), '');
  }
});

test('JSON fences unwrap only the answer, including interrupted fences', () => {
  for (const rawOutput of ['```json\n{"message":"公开回答","actions":[{"type":"PRIVATE"}]}\n```', '```json\n{"message":"公开回答', '~~~\n{"message":"公开回答","actions":[]}\n~~~']) {
    assert.equal(Outcome.preservePartial({}, {}, { rawOutput, inspect }), '公开回答');
  }
  for (const rawOutput of ['```json', '```', '```json\n', '```\n  ', '~~~json\n{"knowledgeRequests":[{"message":"PRIVATE"}]}']) {
    assert.equal(Outcome.preservePartial({}, {}, { rawOutput, inspect }), '');
  }
  const codeAnswer = '```python\nprint("hello")\n```';
  assert.equal(Outcome.preservePartial({}, {}, { rawOutput: codeAnswer, inspect }), codeAnswer);
});

test('raw and split DSML do not survive while intentional protocol examples retain transport policy', () => {
  for (const rawOutput of ['<｜DSML｜ calls>', '<||DSM', '<||', '之前的文字\n<||DSML|| calls>']) {
    assert.equal(Outcome.preservePartial({}, {}, { rawOutput, inspect }), '');
    assert.equal(Outcome.preservePartial({}, {}, { rawOutput }), '');
  }
  const examples = ['示例：\n```xml\n<||DSML|| calls>\n```', '> <||DSML|| calls>', '使用 `<||DSML|| calls>` 标记协议。'];
  for (const rawOutput of examples) assert.equal(Outcome.preservePartial({}, {}, { rawOutput, inspect }), rawOutput);
  assert.equal(Outcome.preservePartial({}, {}, { rawOutput: '{"message":"<||DSML|| calls>"}', inspect }), '');
});

test('explicit parsed plan message is preserved without publishing the rest of the plan', () => {
  const parsedPlan = { message: '# 整理结果\n\n已归纳前两页。', actions: [{ type: 'create_note', content: 'PRIVATE' }], knowledgeRequests: [{ message: 'PRIVATE' }] };
  const before = JSON.stringify(parsedPlan);
  assert.equal(Outcome.preservePartial({ planPreview: true }, {}, { parsedPlan, inspect }), parsedPlan.message);
  assert.equal(JSON.stringify(parsedPlan), before);
  assert.equal(Outcome.preservePartial({}, {}, { parsedPlan: { message: '{"example":"public JSON answer"}' }, inspect }), '{"example":"public JSON answer"}');
  assert.equal(Outcome.preservePartial({}, {}, { parsedPlan: { message: '<||DSML|| calls>' }, inspect }), '');
});

test('generated placeholders and unusable source never persist as a partial answer', () => {
  for (const text of ['正在准备工作流…', '正在阅读附件并制定整理计划…', '正在分析需求并制定计划…', '正在生成可执行计划…', '正在结合资料继续处理…', '已完成整理。', '完成。', 'done', '', '   ']) {
    assert.equal(Outcome.preservePartial({ text }, {}, { inspect }), '');
    assert.equal(Outcome.preservePartial({ text }, {}, { rawOutput: text, inspect }), '');
  }
  assert.equal(Outcome.preservePartial({ text: '正在生成可执行计划…' }, {}, { rawOutput: '{"actions":[', inspect }), '');
  assert.equal(Outcome.preservePartial({ text: 'actual answer' }, {}, { rawOutput: '', inspect }), '', 'explicit empty model source must not fall back to stale display text');
  assert.equal(Outcome.preservePartial({}, {}, { rawOutput: 'answer', inspect: () => { throw Error('guard unavailable'); } }), '');
});

test('a gateway preamble does not expose internal plan fields, while its public message is recoverable', () => {
  for (const rawOutput of ['下面是计划：\n{"actions":[{"message":"PRIVATE"}]}', '下面是计划：\n```json\n{"knowledgeRequests":[{"message":"PRIVATE"}]}\n```']) {
    assert.equal(Outcome.preservePartial({}, {}, { rawOutput, inspect }), '');
  }
  assert.equal(Outcome.preservePartial({}, {}, { rawOutput: '下面是计划：\n{"message":"已归纳到第二章","actions":[', inspect }), '已归纳到第二章');
  assert.equal(Outcome.preservePartial({ text: '```json\n{"actions":[{"message":"PRIVATE"}]}\n```' }, {}, { inspect }), '');
  assert.equal(Outcome.preservePartial({}, {}, { rawOutput: '已完成第一章分析，下面是具体结果：A', inspect }), '已完成第一章分析，下面是具体结果：A');
});


test('rejected empty artifact retains substantive single-sentence analysis while bare success claims disappear', () => {
  const run = { errorCode: 'INCOMPLETE_ANALYSIS_RESULT' };
  for (const text of ['已完成整理，笔记已保存。', '已完成资料分析。', 'Analysis complete.']) {
    assert.equal(Outcome.preservePartial({}, run, { parsedPlan: { message: text }, inspect }), '');
  }
  for (const text of ['已分析你的材料，核心方法是使用前文条件概率估计下一个词，平滑用于缓解未见词序列的零概率。', '已完成第一章分析，下面是具体结果：A']) {
    assert.equal(Outcome.preservePartial({}, run, { parsedPlan: { message: text }, inspect }), text);
  }
});
