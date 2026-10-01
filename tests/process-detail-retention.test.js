const assert = require('node:assert/strict');
const C = require('../app/workstation-core.js');

// 过程详情（steps / toolCalls / activities / commands）是用户回看"这一轮 AI 到底做了什么"的唯一依据：
//   · 对话里的过程流   → 读 message.steps + message.activities（agent-progress.js）
//   · 执行历史对话框   → 读 run.steps + run.toolCalls（run-history.js renderDetail）
// 曾经有一条"给最老的 run 做过程明细瘦身"的空间优化建议 —— 那会悄悄删掉用户明确想要的功能。
// 这组断言锁定相反的方向：过程详情**永不**被迁移、规范化或保存/加载往返丢弃或改写。

const deep = value => JSON.parse(JSON.stringify(value));
const detailOf = run => ({ steps: run.steps, activities: run.activities, toolCalls: run.toolCalls, commands: run.commands });

function detailRun() {
  return {
    id: 'run-1', goal: '整理论文库', status: 'completed',
    startedAt: 1700000000000, finishedAt: 1700000005000, model: 'gpt-x',
    steps: [
      { id: 'step-1', text: '分析目标、附件与已有项目', status: 'done', at: 1700000000100 },
      { id: 'step-2', text: '模型思考与规划', status: 'done', at: 1700000000200 },
      { id: 'step-3', text: '读取原始资料', status: 'done', at: 1700000000300 }
    ],
    activities: [
      { id: 'act-1', kind: 'reasoning', label: '深度思考', text: '先确认论文库的目录结构…', status: 'done', at: 1700000000150, ms: 4200 },
      { id: 'act-2', kind: 'tool', name: 'knowledge', title: '读取笔记', status: 'done', at: 1700000000250, ms: 1500, request: { type: 'capabilities', name: 'knowledge' }, result: { loaded: true } }
    ],
    toolCalls: [{ id: 'call-1', name: 'knowledge', status: 'done', startedAt: 1700000000250, finishedAt: 1700000000400, args: { offset: 0 } }],
    commands: [{ id: 'cmd-1', argv: ['du', '-sh', '*'], exitCode: 0, startedAt: 1700000000450, finishedAt: 1700000000500, output: '128M\tvault' }],
    attachmentSnapshots: { a1: JSON.stringify({ id: 'a1', name: '论文A.pdf' }), a2: 'v1-keepme-000000-000000' },
    results: [{ type: 'note', id: 'n1' }]
  };
}

function fixture() {
  const run = detailRun();
  return {
    agentRuns: [run],
    conversations: [{ id: 'c1', title: '论文库整理', messages: [{ id: 'm1', role: 'agent', runId: 'run-1', steps: run.steps, activities: run.activities }] }]
  };
}

// ① 迁移只碰附件快照：过程详情与 run 的其它字段逐字段不变。
{
  const state = fixture();
  const run = state.agentRuns[0];
  const before = deep(run);
  const migrated = C.migrateAttachmentSnapshots(state);
  assert.equal(migrated, 1, '只有旧格式（原文 JSON）的快照需要迁移，新格式不动');
  Object.keys(before).filter(key => key !== 'attachmentSnapshots').forEach(key => {
    assert.deepEqual(deep(run[key]), before[key], `迁移不得改写 run 的 ${key} 字段`);
  });
  assert.deepEqual(deep(run.attachmentSnapshots), { a1: C.contentStamp(before.attachmentSnapshots.a1), a2: 'v1-keepme-000000-000000' }, '只有旧格式快照被换成指纹');
}

// ② 两份存储都完整：执行历史读的 run 那份、对话过程流读的 message 那份。
{
  const state = fixture();
  const before = detailOf(state.agentRuns[0]);
  C.migrateAttachmentSnapshots(state);
  const run = state.agentRuns[0];
  assert.deepEqual(deep(detailOf(run)), deep(before), '执行历史读到的过程详情必须逐字段完整');
  const message = state.conversations[0].messages[0];
  assert.deepEqual(deep({ steps: message.steps, activities: message.activities }), deep({ steps: before.steps, activities: before.activities }), '对话过程流读到的步骤与活动必须完整');
  // 数量也不能被"瘦身"：steps 从 3 减到 2 也要失败。
  assert.equal(run.steps.length, 3, '步骤条数不得减少');
  assert.equal(run.activities.length, 2, '活动条数不得减少');
  assert.equal(run.toolCalls.length, 1, '工具调用记录不得减少');
  assert.equal(run.commands.length, 1, '终端命令记录不得减少');
}

// ③ 保存 / 加载往返（JSON 往返即真实持久化路径）后过程详情逐字节等价。
{
  const state = fixture();
  C.migrateAttachmentSnapshots(state);
  const roundTrip = JSON.parse(JSON.stringify(state));  // 序列化 → 落盘 → 解析（同一条路径）
  const run = roundTrip.agentRuns[0];
  assert.deepEqual(deep(detailOf(run)), deep(detailOf(state.agentRuns[0])), '往返后 run 的过程详情必须逐字节等价');
  assert.equal(run.steps[1].text, '模型思考与规划', '阶段文案必须原样保留');
  assert.equal(run.activities[0].text, '先确认论文库的目录结构…', '深度思考正文必须原样保留（不得被摘要或截断）');
  assert.equal(run.activities[1].request.name, 'knowledge', '工具调用的参数必须原样保留');
  assert.equal(run.commands[0].output, '128M\tvault', '命令输出必须原样保留');
  const message = roundTrip.conversations[0].messages[0];
  assert.equal(message.steps.length, 3, '往返后对话过程流的步骤必须完整');
  assert.equal(message.activities.length, 2, '往返后对话过程流的活动必须完整');
}

// ④ 幂等：再跑一次迁移不得改写任何内容，过程详情保持完整。
{
  const state = fixture();
  C.migrateAttachmentSnapshots(state);
  const after = deep(state.agentRuns[0]);
  assert.equal(C.migrateAttachmentSnapshots(state), 0, '第二次迁移不得再改写任何内容');
  assert.deepEqual(deep(state.agentRuns[0]), after, '幂等迁移不得触碰任何字段（含过程详情）');
}

// ⑤ 迁移不误伤：没有附件快照的 run（例如失败/取消的执行）过程详情同样不得被改写。
{
  const state = fixture();
  delete state.agentRuns[0].attachmentSnapshots;
  const before = deep(state.agentRuns[0]);
  C.migrateAttachmentSnapshots(state);
  assert.deepEqual(deep(state.agentRuns[0]), before, '没有快照字段的 run 必须原样通过');
}
