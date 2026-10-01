const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Skills = require('../app/skills-core');
const Web = require('../app/conversation-web');
const Context = require('../app/agent-context');
const source = fs.readFileSync(require.resolve('../app/app'), 'utf8');
const sendStart = source.indexOf('async function sendMessage(');
const start = source.indexOf('    const paperWorkflow =', sendStart);
const end = source.indexOf('    const retrievalQuery =', start);
assert.ok(start > sendStart && end > start, 'Evaluate the actual sendMessage paper/skill injection, not a mirrored implementation');
function prompt(goal, { skillId = null, skillIds, enabled = true, onDemand = false } = {}) {
  const state = { settings: { skillsEnabled: enabled }, papers: [] };
  const conversation = { id: 'fixture-conversation', skillId, ...(skillIds ? { skillIds } : {}) };
  // Use the exact production submission snapshot API. Selection may be legacy
  // or plural; disabled entries must never reach paper detection or injection.
  const skillSnapshot = Skills.requestSnapshot(state, conversation);
  const context = vm.createContext({ goal, state, conversation, skillSnapshot, visiblePaper: () => true,
    WorkstationSkillsCore: Skills, ConversationWeb: Web,
    window: { WorkstationSkillsCore: Skills, ConversationWeb: Web, ...(onDemand ? { AgentContext: Context } : {}) },
    run: { workspace: 'auto', webSearch: false }, instruction: '' });
  vm.runInContext(source.slice(start, end), context);
  if (!onDemand) return { text: context.instruction, workspace: context.run.workspace };
  const agent = Context.create({ fullInstruction: context.instruction, workflowInstructions: Skills.instructionsFromSnapshot(state, skillSnapshot), history: { text: '{}' } });
  const initial = agent.instructions();
  // Research schema remains on demand, while selected workflows are present
  // before any tool request. Loading the schema must not duplicate the guide.
  agent.capability('research');
  return { text: agent.instructions(), initial, workspace: context.run.workspace };
}
const occurrences = text => text.split('论文深读标准（工作站适配版）').length - 1;

test('automatic paper requests and arXiv links receive the adapted guide exactly once', () => {
  for (const onDemand of [false, true]) for (const goal of ['请阅读这篇论文并保存笔记', '分析 https://arxiv.org/abs/1234.56789']) {
    const result = prompt(goal, { onDemand });
    assert.equal(occurrences(result.text), 1);
    assert.equal(result.workspace, '科研');
    assert.match(result.text, /counterArguments.*dataGaps/);
    assert.match(result.text, /不自动设置 reviewed=true/);
    assert.doesNotMatch(result.text, /\/Users\/|\.obsidian/);
  }
});

test('selected paper skill first or later in the snapshot appears exactly once in both prompt paths', () => {
  for (const onDemand of [false, true]) for (const selection of [{ skillId: 'builtin-paper' }, { skillIds: ['builtin-paper', 'builtin-materials'] }, { skillIds: ['builtin-materials', 'builtin-paper'] }]) {
    const result = prompt('继续分析', { ...selection, onDemand });
    assert.equal(occurrences(result.text), 1);
    assert.equal(result.workspace, '科研');
    assert.match(result.text, /只问答、比较或核对时遵守用户要求，不自动修改资料/);
    if (onDemand) assert.equal(occurrences(result.initial), 1, 'selected paper guide must reach the initial request before research capability loading');
  }
});

test('disabled selection cannot trigger paper behavior, while an explicit paper request retains the task guide', () => {
  for (const onDemand of [false, true]) {
    const disabled = prompt('继续分析', { skillIds: ['builtin-materials', 'builtin-paper'], enabled: false, onDemand });
    assert.equal(occurrences(disabled.text), 0);
    assert.equal(disabled.workspace, 'auto');
    const explicit = prompt('请阅读这篇论文并保存笔记', { skillIds: ['builtin-materials', 'builtin-paper'], enabled: false, onDemand });
    assert.equal(occurrences(explicit.text), 1);
    assert.equal(explicit.workspace, '科研');
  }
});

test('ordinary course or daily requests do not inherit the research template', () => {
  for (const goal of ['请把这份课件整理成课程笔记', '明天下午三点取两张五十元纸币']) {
    const result = prompt(goal);
    assert.equal(occurrences(result.text), 0);
    assert.equal(result.workspace, 'auto');
  }
});
