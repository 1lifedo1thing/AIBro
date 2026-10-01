/* Synthetic data only. Run in an isolated AI Bro fixture store after hydration.
 * Re-running refreshes the UI without replacing a fixture's edits or drafts. */
;(async function documentOriginFixture() {
  while (!storageHydrated) await new Promise(resolve => setTimeout(resolve, 25));
  if (!state.projects.some(project => project.id === 'origin-alpha')) {
    const now = Date.now();
    state.projects = [
      { id: 'origin-alpha', name: '甲 · 从项目成果返回原始入口的研究工作区', workspace: '科研', createdAt: now },
      { id: 'origin-beta', name: '乙 · 独立课程资料', workspace: '课程', createdAt: now },
    ];
    state.notes = [
      { id: 'origin-output', title: '甲项目成果', content: '# 甲项目成果\n\n正式知识库里的原文。\n\n## 证据\n\n返回入口不能覆盖这段原文。', projectId: 'origin-alpha', workspace: '科研', createdAt: now, updatedAt: now },
      { id: 'origin-knowledge', title: '甲项目阅读资料', content: '# 阅读资料\n\n从资料列表打开的笔记。', sourceAttachmentIds: ['origin-attachment'], projectId: 'origin-alpha', workspace: '科研', createdAt: now, updatedAt: now },
      { id: 'origin-beta-note', title: '乙项目笔记', content: '# 乙项目笔记\n\n这个标签应始终返回乙项目的资料入口。', projectId: 'origin-beta', workspace: '课程', createdAt: now, updatedAt: now },
      { id: 'origin-trail-a', title: '链接起点', content: '# 链接起点\n\n[打开中间文档](middle.md)', projectId: 'origin-alpha', workspace: '科研', createdAt: now, updatedAt: now },
      { id: 'origin-trail-b', title: '链接中间文档', content: '# 链接中间文档\n\n[再次打开起点](start.md)\n\n[打开末端文档](end.md)', projectId: 'origin-alpha', workspace: '科研', createdAt: now, updatedAt: now },
      { id: 'origin-trail-c', title: '链接末端文档', content: '# 链接末端文档\n\n返回应回到中间文档。', projectId: 'origin-alpha', workspace: '科研', createdAt: now, updatedAt: now },
      { id: 'origin-portable', title: '可移动资料', content: '# 可移动资料\n\n文档移动以后，旧入口可能不可用；阅读区仍能收起。', projectId: 'origin-alpha', workspace: '科研', createdAt: now, updatedAt: now },
    ];
    state.imports = [{ id: 'origin-attachment', name: '对话中的原始材料.txt', originalName: '对话中的原始材料.txt', mimeType: 'text/plain', content: 'Attachment from the exact original message.\nSynthetic test material only.', projectId: 'origin-alpha', workspace: '科研', status: 'parsed', createdAt: now }];
    state.tasks = [{ id: 'origin-task', title: '核对文档入口', projectId: 'origin-alpha', workspace: '科研', status: 'todo', description: '从任务关联知识打开资料，返回应回到这个任务。', sourceNoteIds: ['origin-knowledge'], sourceAttachmentIds: ['origin-attachment'], createdAt: now }];
    state.conversations = [
      { id: 'origin-chat-a', title: '讨论研究成果与来源', projectId: 'origin-alpha', workspace: '科研', draft: '尚未发送的问题', attachments: [], draftAttachmentIds: [], createdAt: now, updatedAt: now,
        messages: [
          { id: 'origin-message-first', role: 'user', text: '这条消息带着需要回看的附件。', attachmentIds: ['origin-attachment'], at: now - 5000 },
          ...Array.from({ length: 10 }, (_, index) => ({ id: 'origin-message-' + index, role: index % 2 ? 'agent' : 'user', text: '定位消息测试段落 ' + index + '\n\n' + '保持会话滚动位置。'.repeat(12), at: now - 4000 + index })),
          { id: 'origin-result-message', role: 'agent', text: '已经保存甲项目成果。', runId: 'origin-run-output', runStatus: 'completed', results: [{ type: 'note', id: 'origin-output', operation: 'created' }], at: now },
        ] },
      { id: 'origin-chat-b', title: '乙项目课程问题', projectId: 'origin-beta', workspace: '课程', draft: '', messages: [], attachments: [], draftAttachmentIds: [], createdAt: now },
    ];
    state.agentRuns = [{ id: 'origin-run-output', conversationId: 'origin-chat-a', projectId: 'origin-alpha', status: 'completed', startedAt: now - 2000, finishedAt: now, results: [{ type: 'note', id: 'origin-output', operation: 'created' }] }];
    state.papers = []; state.trash = []; state.currentConversationId = 'origin-chat-a'; state.currentProjectId = 'origin-alpha';
    state.ui.workspaceNavigation = { projects: {} }; state.ui.projectTab = 'outputs';
    state.ui.documentWorkspace = { version: 1, tabs: [], activeKey: null, visible: false, expanded: false };
    state.ui.onboarding = { version: window.WorkstationOnboarding?.VERSION || 1, status: 'skipped' };
    state.ui.workspaceTour = { version: 1, status: 'skipped' }; state.ui.theme = 'light'; state.ui.inspectorOpen = false;
    state.settings.reduceMotion = true;
    normalizeStateShape(state); await saveDocumentDurably();
  }
  // This is the real Wiki resolver's file-index shape. No resolver is mocked.
  // The trail cases run before restart; persistence cases use ordinary notes.
  state._wikiFiles ||= {};
  for (const [id, name] of [['origin-trail-a', 'start.md'], ['origin-trail-b', 'middle.md'], ['origin-trail-c', 'end.md']]) state._wikiFiles[id] = { path: 'origin-fixture/' + name };
  window.WorkstationOnboarding?.close(); window.WorkspaceTour?.close(); applyUiPreferences(); renderAll();
  window.__documentOriginFixtureReady = true;
})();
