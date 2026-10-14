'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Chain = require('../app/model-chain.js');

const defaults = { provider: 'api', model: 'global-model', effort: 'medium' };

test('the chain resolves conversation → project → workspace → global, in that order', () => {
  const settings = { workspaceModelConfig: { 科研: { provider: 'api', model: 'workspace-model', effort: 'low' } } };
  const conversation = { modelConfig: { provider: 'api', model: 'conversation-model', effort: 'high' } };
  const project = { modelConfig: { provider: 'api', model: 'project-model', effort: 'low' } };
  assert.equal(Chain.resolve({ conversation, project, settings, workspace: '科研' }, defaults).model, 'conversation-model', '对话设定优先级最高');
  assert.equal(Chain.resolve({ conversation: {}, project, settings, workspace: '科研' }, defaults).model, 'project-model', '没有对话设定时落到项目');
  assert.equal(Chain.resolve({ conversation: {}, project: {}, settings, workspace: '科研' }, defaults).model, 'workspace-model', '没有项目设定时落到工作区');
  assert.equal(Chain.resolve({ conversation: {}, project: {}, settings, workspace: '课程' }, defaults).model, 'global-model', '该工作区没配过就用全局默认');
  assert.equal(Chain.resolve({}, defaults).model, 'global-model');
});

test('an unconfigured level is skipped rather than guessed, and the source is reported honestly', () => {
  const settings = { workspaceModelConfig: { 日常: { provider: 'api', model: '', effort: 'high' } } };
  const resolved = Chain.resolve({ conversation: {}, project: { modelConfig: { provider: 'api', model: '   ' } }, settings, workspace: '日常' }, defaults);
  // 只写了空模型名不算配置过：不能因为"这一级有对象"就停在它上面。
  assert.equal(resolved.model, 'global-model');
  assert.equal(resolved.source, 'default');
  assert.equal(Chain.describe(resolved), '', '全局默认不必赘述');
  const fromProject = Chain.resolve({ project: { modelConfig: { provider: 'openai-auth', model: 'p1' } } }, defaults);
  assert.equal(fromProject.source, 'project');
  assert.equal(fromProject.provider, 'openai-auth', '提供方要跟着来源一起带过来');
  assert.match(Chain.describe(fromProject), /项目设定/);
});

test('effort and provider are normalized without inventing values', () => {
  const resolved = Chain.resolve({ conversation: { modelConfig: { provider: 'weird', model: 'm', effort: 'auto' } } }, defaults);
  assert.equal(resolved.provider, 'api', '未知提供方按 api 处理（与既有配置解析一致）');
  assert.equal(resolved.effort, '', 'auto 视为未指定，不编造档位');
  const none = Chain.resolve({ conversation: { modelConfig: { model: 'm', effort: 'xhigh' } } }, {});
  assert.equal(none.effort, 'xhigh');
  assert.equal(none.provider, 'api');
  // 没有工作区名时不得去查工作区配置（避免把"未知工作区"当成某个具体工作区）。
  assert.equal(Chain.workspaceConfig({ workspaceModelConfig: { 科研: { model: 'x' } } }, ''), null);
  assert.equal(Chain.workspaceConfig({}, '科研'), null);
  assert.deepEqual(Object.keys(Chain.candidates({}, {})), ['conversation', 'project', 'workspace', 'default']);
});

test('legacy shape keeps working: no project or workspace config behaves exactly as before', () => {
  const conversation = { modelConfig: { provider: 'api', model: 'c1', effort: 'max' } };
  assert.deepEqual(Chain.resolve({ conversation }, defaults), { provider: 'api', model: 'c1', effort: 'max', source: 'conversation' });
  assert.deepEqual(Chain.resolve({ conversation: {} }, defaults), { provider: 'api', model: 'global-model', effort: 'medium', source: 'default' });
  // 未配置任何模型（未填全局默认）时也不能凭空造一个模型名出来。
  assert.deepEqual(Chain.resolve({}, {}), { provider: 'api', model: '', effort: '', source: 'default' });
});

test('explicit account provider with an empty model is an official default at each inheritance level',()=>{
 for(const provider of ['openai-auth','claude-auth']){
  const selected={provider,model:'',effort:''};const settings={workspaceModelConfig:{科研:selected}};
  assert.deepEqual(Chain.resolve({conversation:{modelConfig:selected},project:{modelConfig:{model:'other'}},settings,workspace:'科研'},defaults),{...selected,source:'conversation'});
  assert.deepEqual(Chain.resolve({conversation:{modelConfig:{}},project:{modelConfig:selected},settings,workspace:'科研'},defaults),{...selected,source:'project'});
  assert.deepEqual(Chain.resolve({conversation:{modelConfig:{}},project:{modelConfig:{provider:'api',model:''}},settings,workspace:'科研'},defaults),{...selected,source:'workspace'});
  assert.deepEqual(Chain.resolve({conversation:{modelConfig:{}}},selected),{...selected,source:'default'});
 }
});

test('actual app defaults and resolveRunModel carry Claude official default through conversation/project/workspace/global',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
 const cut=name=>{const start=source.indexOf('function '+name+'('),rest=source.slice(start),end=rest.search(/\n(?:async )?function /);return rest.slice(0,end<0?undefined:end);};
 const settings={workspaceModelConfig:{科研:{provider:'claude-auth',model:'',effort:''}}};const state={settings,projects:[{id:'p',workspace:'科研',modelConfig:{provider:'claude-auth',model:'opus'}}]};
 const context=vm.createContext({state,ModelChain:Chain,workspaceName:v=>v,OpenAIAuth:{provider:()=> 'claude-auth'},ClaudeAuth:{model:()=>''},$:()=>{throw Error('Claude default must not read API field');},localStorage:{getItem:()=>{throw Error('must not read API storage');}}});context.window=context;
 vm.runInContext(cut('defaultModelConfiguration')+cut('resolveRunModel'),context);
 const resolve=conversation=>JSON.parse(JSON.stringify(context.resolveRunModel(conversation)));
 assert.deepEqual(resolve({modelConfig:{provider:'claude-auth',model:'haiku'},projectId:'p',workspace:'科研'}),{provider:'claude-auth',model:'haiku',effort:'',source:'conversation'});
 assert.equal(resolve({modelConfig:{},projectId:'p',workspace:'科研'}).model,'opus');state.projects[0].modelConfig={};assert.equal(resolve({projectId:'p',workspace:'科研'}).source,'workspace');
 assert.deepEqual(resolve({workspace:'日常'}),{provider:'claude-auth',model:'',effort:'',source:'default'});
});
