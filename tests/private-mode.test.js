'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 无痕模式的纯逻辑：可见性规则、搜索排除、删除计划、告知文案。
const P = require(path.join(__dirname, '../app/private-mode.js'));
const pure = P._pure;

test('无痕对话在普通模式下不出现在列表里', () => {
  const privateChat = { id: 'a', ephemeral: true };
  const normal = { id: 'b' };
  assert.equal(pure.visibleInList(privateChat, { enabled: false }), false);
  assert.equal(pure.visibleInList(normal, { enabled: false }), true);
});

test('隐私模式下只显示本次会话的无痕对话（普通对话被隐藏，退出后恢复）', () => {
  const privateChat = { id: 'a', ephemeral: true };
  const normal = { id: 'b' };
  assert.equal(pure.visibleInList(privateChat, { enabled: true }), true);
  assert.equal(pure.visibleInList(normal, { enabled: true }), false, '隐私模式下不显示普通对话');
  assert.equal(pure.visibleInList(normal, { enabled: false }), true, '退出后普通对话恢复显示');
});

test('正在查看的那条无痕对话始终可见——不让它在界面上"凭空丢失"', () => {
  assert.equal(pure.visibleInList({ id: 'a', ephemeral: true }, { enabled: false, currentId: 'a' }), true);
});

test('全文搜索绝对排除无痕对话（与模式无关）', () => {
  assert.equal(pure.searchable({ id: 'a', ephemeral: true }), false);
  assert.equal(pure.searchable({ id: 'b' }), true);
});

test('删除计划包含无痕对话与它们的执行记录——不留残渣', () => {
  const state = {
    conversations: [{ id: 'a', ephemeral: true }, { id: 'b' }, { id: 'c', ephemeral: true }],
    agentRuns: [{ id: 'r1', conversationId: 'a' }, { id: 'r2', conversationId: 'b' }, { id: 'r3', conversationId: 'c' }]
  };
  const plan = pure.purgePlan(state);
  assert.deepEqual(plan.conversations.map(item => item.id).sort(), ['a', 'c']);
  assert.deepEqual(plan.runs.map(item => item.id).sort(), ['r1', 'r3'], '无痕对话的执行记录也要一起删');
  assert.equal(plan.ids.has('b'), false);
});

test('没有无痕对话时删除计划为空——不会误删普通内容', () => {
  const plan = pure.purgePlan({ conversations: [{ id: 'b' }], agentRuns: [] });
  assert.equal(plan.conversations.length, 0);
  assert.equal(plan.runs.length, 0);
});

test('告知文案明确写出"永久删除、不可恢复"——不让它看起来像故障', () => {
  const notice = pure.noticeText();
  assert.match(notice, /永久删除/);
  assert.match(notice, /不可恢复/);
  assert.match(notice, /搜索/);
});

test('模块暴露的接入口齐全', () => {
  for (const name of ['init', 'setEnabled', 'mark', 'purge', 'render', 'shows', 'searchable', 'isOn']) {
    assert.equal(typeof P[name], 'function', `缺少 ${name}`);
  }
});

test('开启无痕在展示提示前进入独立会话，退出只清除无痕记录', () => {
  const ordinary={id:'ordinary',messages:[{text:'保留原文'}]};
  const state={conversations:[ordinary],agentRuns:[],currentConversationId:'ordinary'};
  const events=[];
  P.init({getState:()=>state,onEnter:()=>{assert.equal(P.isOn(),true);const privateChat={id:'private',messages:[]};P.mark(privateChat);state.conversations.push(privateChat);state.currentConversationId=privateChat.id;events.push('entered');},toast:()=>events.push('notice')});
  P.setEnabled(true);
  assert.deepEqual(events,['entered','notice']);
  assert.equal(state.currentConversationId,'private');
  assert.equal(ordinary.ephemeral,undefined);
  P.setEnabled(false);
  assert.deepEqual(state.conversations,[ordinary]);
  assert.equal(state.currentConversationId,'ordinary');
});
