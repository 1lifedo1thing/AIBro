/* ISOLATED STORE ONLY. Synthetic provider, real send/execution/persistence.
 * This setup does not send a message. In the real composer, send:
 * 整理这份资料并保存分析笔记 [QA:EMPTY-NOTE]
 * 整理这份资料并保存分析笔记 [QA:VALID-OUTPUT]
 * Additional renderer scenarios: MISSING-BODY, PLACEHOLDER, MIXED-EMPTY.
 * Re-injection retains the fixture's existing records and execution history. */
;(async function deliverableIntegrityFixture() {
  while (!storageHydrated) await new Promise(resolve => setTimeout(resolve,25));
  const projectId = 'integrity-project', conversationId = 'integrity-chat', sourceId = 'integrity-source';
  const body = '# 材料分析成果\n\n## 来源与范围\n\n依据《成果验收资料.txt》中的三条合成事实整理：文档返回入口属于当前标签；资料与成果应保持不同含义；草稿需在明确保存后才成为正式正文。本次没有联网，也没有核对该资料以外的信息。\n\n## 可核验结论\n\n1. 切换项目后，已打开文档仍应返回原项目及原分区。\n2. “执行完成”需要存在可打开的正文，只有标题的空文件不能代替分析结果。\n3. 离开编辑器时可以保留本机草稿，不能自动覆盖正式知识库正文。\n\n## 待确认\n\n真实模型生成质量、真实 PDF 解析完整度不在这份合成资料的验证范围内。';
  if (!state.projects.some(project => project.id === projectId)) {
    const now = Date.now();
    state.projects = [{ id: projectId, name: '成果完整性 · 隔离验收', workspace: '日常', description: '仅使用合成资料与合成 provider，验证真实执行保存链路。', createdAt: now }];
    state.imports = [{ id: sourceId, name: '成果验收资料.txt', originalName: '成果验收资料.txt', mimeType: 'text/plain', content: '三条合成资料事实：\n1. 文档返回入口属于当前标签，切换项目不应改写旧标签入口。\n2. 资料是原始输入，成果是可打开核对的实际正文；空标题不能代替分析结果。\n3. 草稿与正式正文分开，只有明确保存才会替换正式正文。', status: 'parsed', parser: 'text', workspace: '日常', projectId, createdAt: now, updatedAt: now }];
    state.notes = [{ id: 'integrity-baseline-note', title: '已有笔记保持原样', content: '# 原有正文\n\n无效计划不能修改这份既有资料。', workspace: '日常', createdAt: now, updatedAt: now }];
    state.tasks = [{ id: 'integrity-baseline-task', title: '原有任务', status: 'todo', workspace: '日常', projectId, createdAt: now }];
    state.papers = []; state.trash = []; state.agentRuns = [];
    state.conversations = [{ id: conversationId, title: '成果完整性验收', workspace: '日常', projectId, permissionMode: 'auto', modelConfig: { provider: 'api', model: 'synthetic-deliverable-fixture', effort: 'medium' }, messages: [], attachments: [sourceId], draftAttachmentIds: [sourceId], draft: '', createdAt: now }];
    state.currentConversationId = conversationId; state.currentProjectId = projectId;
    state.ui.onboarding = { version: window.WorkstationOnboarding?.VERSION || 1, status: 'skipped' };
    state.ui.workspaceTour = { version: 1, status: 'skipped' }; state.ui.inspectorOpen = false; state.ui.theme = 'light';
    state.settings.permissions = { '日常': 'auto', '课程': 'auto', '科研': 'auto' }; state.settings.reduceMotion = true;
    normalizeStateShape(state); await saveDocumentDurably();
  }
  // Neither original credential accessor runs. No real token or keychain read.
  captureApiConnection = () => ({ base: 'https://synthetic-fixture.invalid/v1', token: 'FICTIONAL-NONSECRET-FIXTURE-KEY', protocol: 'responses' });
  getApiConnection = async () => ({ base: 'https://synthetic-fixture.invalid/v1', token: 'FICTIONAL-NONSECRET-FIXTURE-KEY', protocol: 'responses' });
  ConversationModels.resolve = async config => ({ ...config, provider: 'api', model: 'synthetic-deliverable-fixture' });
  window.__integrityProviderCalls ||= [];
  window.__integrityBody = body;
  AgentTransport.requestPlan = async options => {
    const run = state.agentRuns.find(item => item.id === activeRunId) || state.agentRuns.at(-1);
    const marker = String(run?.goal || '').match(/\[QA:(EMPTY-NOTE|MISSING-BODY|PLACEHOLDER|MIXED-EMPTY|VALID-OUTPUT)\]/)?.[1];
    const input = typeof options.input === 'string' ? options.input : JSON.stringify(options.input);
    if (!marker || !input.includes(`[QA:${marker}]`)) throw Object.assign(Error('合成验收仅响应当前输入中的精确 QA 标记。'), { code: 'SYNTHETIC_MARKER_REQUIRED' });
    if (options.signal?.aborted) throw Object.assign(Error('已取消合成响应'), { code: 'CANCELLED' });
    const action = { type: marker === 'EMPTY-NOTE' ? 'create_note' : 'create_knowledge_item', title: marker === 'VALID-OUTPUT' ? '材料分析成果' : '不应保存的空分析', workspace: '日常', projectId, sourceAttachmentIds: [sourceId] };
    if (marker !== 'MISSING-BODY') action.content = marker === 'VALID-OUTPUT' ? body : marker === 'PLACEHOLDER' ? '# 不应保存的空分析\n\n待补充' : '';
    const actions = marker === 'MIXED-EMPTY' ? [
      { type: 'rename_attachment', attachmentId: sourceId, newName: '错误计划不应重命名.txt' },
      { type: 'create_task', title: '错误计划不应创建任务', description: '必须与空成果一起原子拒绝。', workspace: '日常', projectId, priority: 'medium', status: 'todo', sourceAttachmentIds: [sourceId] },
      action,
    ] : [action];
    window.__integrityProviderCalls.push({ runId: run.id, marker, inputCharacters: input.length,
      formatRepair: input.includes('上一份计划未通过本地校验，尚未执行任何动作'),
      loadedCapabilities: [...(run.contextMetrics?.loadedCapabilities || [])], actionTypes: actions.map(item => item.type) });
    return JSON.stringify({ workspace: '日常', message: marker === 'VALID-OUTPUT' ? '根据《成果验收资料.txt》，文档入口应按标签保留，草稿需与正式正文分开；分析结果已写入可打开的材料分析成果。' : '已完成整理。', actions });
  };
  window.WorkstationOnboarding?.close(); window.WorkspaceTour?.close(); applyUiPreferences(); renderAll();
  if (document.body.dataset.view !== 'agent' || state.currentConversationId !== conversationId) await navigateWorkspaceConversation(conversationId);
  window.__deliverableIntegrityFixtureReady = true;
})();
