const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ROOT=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(ROOT,file),'utf8');

// 逐条机制的“公开契约”：文件 + 必须存在的导出。
// 这里检查的是对外承诺的能力，不是实现细节——机制被整体删除或改名时会失败，正常重构不会。
const MECHANISMS = [
  { id: 'T1', name: '执行过程折叠（段级呼吸 + 工具类型聚合行）', file: 'app/agent-progress.js', needs: ['markup', 'finish', 'duration', 'pin'] },
  { id: 'T2', name: '上下文压缩 + 机械锚点', file: 'app/conversation-compaction.js', needs: ['compact', 'verifiedItems'] },
  { id: 'T3', name: '运行中插话与队列', file: 'app/agent-queue.js', needs: ['list', 'enqueue', 'shift', 'clear'] },
  { id: 'T4', name: '权限分层（边界 / 审批）', file: 'app/permission-policy.js', needs: ['effectiveMode', 'needsApproval', 'canDelegateReview', 'canSessionAllow', 'allowableTypes'] },
  { id: 'T4b', name: '审查者代批（边界不变、可熔断）', file: 'app/reviewer-delegate.js', needs: ['decide', 'noteFor', 'fallbackNote', 'DENIAL_LIMIT'] },
  { id: 'T5', name: '子代理执行', file: 'app/research-delegation.js', needs: ['execute'] },
  { id: 'T6', name: '变更审阅与撤销', file: 'app/file-review.js', needs: ['capture', 'diff', 'undo'] },
  { id: 'T7', name: '会话树（会话之间的分支关系）', file: 'app/conversation-tree.js', needs: ['parentOf', 'describe', 'syncChip'] },
  { id: 'T7b', name: '消息级会话树（会话内分支可切换）', file: 'app/conversation-branches.js', needs: ['fork', 'switchTo', 'currentId', 'activeMeta', 'count', 'describe', 'label'] },
  { id: 'T8p', name: '先审后做（Plan）', file: 'app/draft-review.js', needs: ['begin', 'prepare', 'resolve', 'command'] },
  { id: 'T8g', name: '目标循环（Goal 自证）', file: 'app/goal-loop.js', needs: ['parse', 'verdict', 'shouldContinue', 'onRoundFinished', 'syncStrip'] },
  { id: 'T9', name: '技能内核与导入', file: 'app/skills-core.js', needs: ['list', 'upsert', 'remove', 'instructions'] },
  { id: 'T10', name: '会话组织（深度链接 / 快照）', file: 'app/conversation-link.js', needs: ['build', 'resolve', 'snapshot', 'fileName'] },
  { id: 'T11', name: '上下文组装（可回查）', file: 'app/agent-context.js', needs: ['history', 'readHistory', 'overview'] },
  { id: 'T12', name: '机械锚点提取', file: 'app/context-anchors.js', needs: ['extract', 'byKind', 'NOTICE'] },
  { id: 'T13', name: '终端区域（只读）', file: 'app/terminal-pane.js', needs: ['init', 'render', 'toggle', 'commandsFor'] },
  { id: 'T14', name: '选区批注与解释', file: 'app/selection-explain.js', needs: ['init', 'open', 'buildInput', 'canApply'] },
  { id: 'T15', name: '按事件类型的提示音', file: 'app/alert-sound.js', needs: ['init', 'play', 'shouldPlay', 'tones'] },
  { id: 'T16', name: '用量估算（不编造价格）', file: 'app/usage-cost.js', needs: ['init', 'read', 'describe', 'estimate'] },
  { id: 'T17', name: '技能导入（风险只告知）', file: 'app/skills-import.js', needs: ['parseDocument', 'scan', 'fromEntries', 'resolve'] },
  { id: 'T18', name: '后台任务实时进度', file: 'app/project-automation.js', needs: ['progressSummary', 'executeClaim', 'validateRun'] },
  { id: 'T19', name: '工具空转预警（机械判定、交回用户）', file: 'app/tool-loop-guard.js', needs: ['inspect', 'signature', 'tally', 'describe', 'LIMIT'] },
  { id: 'T20', name: '模型来源逐级回退（对话→项目→工作区→全局）', file: 'app/model-chain.js', needs: ['resolve', 'candidates', 'normalized', 'workspaceConfig', 'label', 'describe'] },
  { id: 'T21', name: '任务产出校验（未通过不假装完成）', file: 'app/task-deliverable.js', needs: ['validate', 'normalize', 'describe', 'message', 'KINDS'] },
  { id: 'T22', name: '对话产出 → 可编辑文档（原文不改写、只存一次）', file: 'app/note-capture.js', needs: ['plan', 'titleFromMessage', 'findMessage', 'existingNote'] },
  { id: 'T23', name: '结构化问询卡片（选项限定回答、不改写原回复）', file: 'app/clarify-questions.js', needs: ['validate', 'answerText', 'markup'] },
  { id: 'T24', name: '工具执行记录自动呼吸（执行中展开、终态收敛、用户手动优先）', file: 'app/tool-scheduler.js', needs: ['card', 'provider', 'recover'] },
  { id: 'T25', name: '页内查找（命中计数、折叠内容自动展开、只读 DOM）', file: 'app/find-in-conversation.js', needs: ['init', 'open', 'close', 'next', 'prev', 'stats', 'isOpen'] },
  { id: 'T26', name: '模式关键词提示（只提示不改写、Shift+Tab 转换）', file: 'app/mode-hint.js', needs: ['init', 'render', 'convert', 'parsePlan'] },
  { id: 'T27', name: '大回复安全预览（有界纯文本、可双向切换）', file: 'app/safe-preview.js', needs: ['init', 'mount', 'needsPreview', 'describe', 'plainPreview', 'noticeText'] },
  { id: 'T28', name: '会话内任务清单（进度可见、不为了补勾选再跑一轮）', file: 'app/session-tasks.js', needs: ['init', 'render', 'validate', 'merge', 'progress', 'describe', 'shouldShow'] },
  { id: 'T29', name: '快捷键说明面板（清单不编造：每条都在代码里核验）', file: 'app/shortcuts.js', needs: ['init', 'open', 'close', 'entries', 'asText', 'verifiable'] },
  { id: 'T30', name: 'Tab 一键两义（空时填提示、有内容不覆盖）', file: 'app/composer-tips.js', needs: ['init', 'tipAt', 'plan', 'TIPS'] },
  { id: 'T31', name: '消息目录刻度导航（深色刻度=当前可见范围、悬停预览、聚合、点击跳转）', file: 'app/message-rail.js', needs: ['init', 'sync', 'build', 'stats'] },
  { id: 'T32', name: '无痕模式（不进列表与搜索、退出或重启即真删除）', file: 'app/private-mode.js', needs: ['init', 'setEnabled', 'mark', 'purge', 'render', 'shows', 'searchable', 'isOn'] },
  { id: 'T33', name: '原件预览补充形态（视频/音频播放器、CSV 表格、HTML 空沙箱）', file: 'app/preview-media.js', needs: ['mount', 'kindOf', 'parseDelimited', 'bounded', 'tableMarkup'] },
  { id: 'T34', name: '代码块语法高亮（多语言、内容守恒、未知语言不假高亮）', file: 'app/code-highlight.js', needs: ['highlight', 'normalizeLanguage', 'languages'] },
  { id: 'T35', name: '数学公式渲染（$…$ 行内、$$…$$ 块级；未知命令原样显示）', file: 'app/math-render.js', needs: ['inlineMath', 'blockMath', 'symbols'] },
  { id: 'T36', name: '项目排期（周一→周日周视图 + 计划文档；无日期任务不丢）', file: 'app/project-schedule.js', needs: ['init', 'mount', 'render'] },
  { id: 'T37', name: '消息媒体（连续图片合并画廊、视频/音频内嵌、无地址不假渲染）', file: 'app/message-media.js', needs: ['render', 'classify', 'urlFor', 'kindOf'] }
];

// 这些模块在加载时会启动定时器或依赖浏览器环境，require 会挂住测试进程，只做源码检查。
const NODE_UNSAFE = new Set(['app/project-automation.js']);

function exportsOf(file) {
  if (!NODE_UNSAFE.has(file)) {
    try {
      const loaded = require(path.join(ROOT, file));
      if (loaded && Object.keys(loaded).length) return Object.keys(loaded);
    } catch (_) { /* 需要浏览器环境的模块走源码检查 */ }
  }
  const source = read(file);
  const marker = source.match(/(?:root|window)\.[A-Za-z]+=\{[^}]*\}/);
  if (!marker) return [];
  return marker[0].replace(/^[^{]*\{/, '').replace(/\}.*$/, '').split(',').map(part => part.split(':')[0].trim()).filter(Boolean);
}

test('每条机制的实现文件都存在',()=>{
  const missing=MECHANISMS.filter(item=>!fs.existsSync(path.join(ROOT,item.file))).map(item=>`${item.id} ${item.name} → ${item.file}`);
  assert.deepEqual(missing,[],'机制实现文件缺失：'+missing.join('；'));
});

test('每条机制的公开能力仍然存在（防止机制被整体删除）',()=>{
  const broken=[];
  for (const item of MECHANISMS) {
    const keys = exportsOf(item.file);
    for (const need of item.needs) if (!keys.includes(need)) broken.push(`${item.id} ${item.name} 缺少 ${item.file} 的 ${need}（现有：${keys.join(',') || '无'}）`);
  }
  assert.deepEqual(broken,[],'机制契约被破坏：'+broken.join('；'));
});

test('每条机制都有守护它的测试文件（单元或冒烟）',()=>{
  const tests=fs.readdirSync(path.join(ROOT,'tests'));
  const smoke=[
    ['T1','agent-progress-breathing-smoke.cjs'],['T3','agent-queue-smoke.cjs'],['T7','agent-queue-smoke.cjs'],
    ['T8g','agent-queue-smoke.cjs'],['T13','agent-queue-smoke.cjs'],['T14','agent-queue-smoke.cjs'],
    ['T16','agent-queue-smoke.cjs'],['T17','agent-queue-smoke.cjs'],['T18','agent-queue-smoke.cjs'],['T20','agent-queue-smoke.cjs'],['T21','agent-queue-smoke.cjs'],
    ['T4b','agent-queue-smoke.cjs'],['T7b','agent-queue-smoke.cjs'],['T19','agent-queue-smoke.cjs'],['T22','agent-queue-smoke.cjs'],
    ['T23','clarify-smoke.cjs'],['T24','agent-queue-smoke.cjs'],['T25','agent-find-mode-smoke.cjs'],['T26','agent-find-mode-smoke.cjs'],['T27','agent-round2-smoke.cjs'],['T28','agent-round2-smoke.cjs'],['T29','agent-round3-smoke.cjs'],['T30','agent-round3-smoke.cjs'],['T31','agent-round4-smoke.cjs'],['T32','agent-round5-smoke.cjs'],['T33','agent-round7-smoke.cjs'],['T34','agent-round8-smoke.cjs'],['T35','agent-round8-smoke.cjs'],['T36','agent-round9-smoke.cjs'],['T37','agent-round10-smoke.cjs']
  ];
  const unit=['agent-progress','agent-queue','permission-policy','goal-loop','conversation-tree','conversation-branches','reviewer-delegate','tool-loop-guard','model-chain','task-deliverable','skills-core','skills-import','conversation-link','context-anchors','agent-context','terminal-pane','selection-explain','alert-sound','usage-cost','file-review','conversation-compaction','research-delegation','project-automation','draft-review','note-capture','clarify-questions','tool-scheduler','find-in-conversation','mode-hint','safe-preview','session-tasks','shortcuts','composer-tips','message-rail','private-mode','preview-media','code-highlight','math-render','project-schedule','message-media'];
  const missing=[];
  for (const item of MECHANISMS) {
    const viaSmoke=smoke.some(([id,file])=>id===item.id&&tests.includes(file));
    const base=path.basename(item.file,'.js');
    const viaUnit=unit.includes(base)&&tests.some(file=>file.startsWith(base)&&file.includes('.test.'));
    if(!viaSmoke&&!viaUnit) missing.push(`${item.id} ${item.name}`);
  }
  assert.deepEqual(missing,[],'缺少守护测试的机制：'+missing.join('，'));
});

test('脚本标签顺序满足模块依赖（锚点先于上下文组装）',()=>{
  const html=read('app/index.html');
  const anchors=html.indexOf('context-anchors.js');
  const context=html.indexOf('agent-context.js');
  assert.ok(anchors>=0&&context>=0,'两个脚本都应被加载');
  assert.ok(anchors<context,'context-anchors.js 必须先于 agent-context.js 加载');
  const goal=html.indexOf('goal-loop.js');
  assert.ok(goal>=0,'goal-loop.js 应被加载');
});

test('资源契约覆盖全部交互层新增模块',()=>{
  const manifest=JSON.parse(read('app/asset-manifest.json'));
  const required=['goal-loop.js','context-anchors.js','conversation-tree.js','terminal-pane.js','skills-import.js','selection-explain.js','alert-sound.js','usage-cost.js','conversation-link.js','note-capture.js','clarify-questions.js'];
  const missing=required.filter(name=>!manifest.web.includes(name));
  assert.deepEqual(missing,[],'未登记进资源契约：'+missing.join('、'));
});
