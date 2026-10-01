// Fictional release-demo data only. Append after qa-workspace.js in an isolated QA bundle.
// This is seeded history, not a claim that an external model ran during recording.
(()=>{
 const now=Date.now();
 state.projects.find(p=>p.id==='native-qa').description='研究视频采样策略如何影响短事件理解。保留证据、失败记录与下一轮实验。';
 const notes=[
 ['concept','时间采样与事件覆盖','## 定义与范围\n视频采样把连续时间轴转换成有限观测。采样间隔与事件长度共同决定覆盖率。\n\n## 相近概念与区别\n覆盖到事件，不代表模型能解释事件。评测应分别记录覆盖率与回答准确率。\n\n## 下一步\n对比固定间隔和自适应采样。'],
 ['method','自适应关键帧采样','## 核心原理\n先做粗粒度扫描，再在变化较大的片段补充观测。\n\n## 前提与适用条件\n计算预算固定；能够定位候选片段。\n\n## 局限与反例\n缓慢但关键的变化可能被遗漏。\n\n## 实现与使用步骤\n1. 固定预算建立基线。\n2. 对变化片段分配更多采样。\n3. 单独检查短事件子集。'],
 ['experiment','实验 01 · 短事件覆盖','## 实验假设\n相同帧数预算下，自适应采样可能提高短事件覆盖。\n\n## 设置与对照\n固定间隔采样与自适应采样；保持模型、提示词和帧数预算一致。\n\n## 指标与结果\n示例实验计划，尚未运行；不要将假设写成结果。\n\n## 下一步与开放问题\n建立人工标注的短事件子集。'],
 ['failure','均匀采样遗漏短事件','## 问题与症状\n粗采样可能完整跳过短暂动作。\n\n## 尝试与结果\n这是用于展示知识结构的虚构失败记录，没有真实实验指标。\n\n## 复现条件与边界\n优先检查持续时间小于采样间隔的事件。'],
 ['review','Review · 评测可比性','## 原始意见与来源\n示例反馈：需要在相同计算预算下比较两种采样方法。\n\n## 回应与决策\n固定输入帧数，分别报告总集与短事件子集。\n\n## 处理状态\n待验证。'],
 ['idea','问题 · 能否学习采样预算','## 研究问题\n是否可以从粗观测中预测值得加密采样的位置？\n\n## 待验证假设\n先验证覆盖改善，再讨论端到端学习。\n\n## 验证路径\n从小规模对照开始，记录失败案例。']
 ];
 for(const [type,title,body] of notes)state.notes.push({id:'demo-wiki-'+type,title,content:'# '+title+'\n\n'+body,kind:'科研 Wiki/'+type,workspace:'科研',projectId:'native-qa',createdAt:now,updatedAt:now,sourceAttachmentIds:[],tags:['视频理解','采样策略']});
 for(const [i,text] of ['想到一个对照：只改变采样策略，其他条件保持一致。','阅读时发现：平均准确率可能掩盖短事件上的失败。','周五讨论时展示两种采样方式，并记录还不能回答的问题。'].entries())state.notes.push({id:'demo-capture-'+i,title:text,content:text,kind:'随记',workspace:'科研',projectId:'native-qa',tags:['实验灵感'],createdAt:now-i*3600000,updatedAt:now,sourceAttachmentIds:[]});
 const chat=state.conversations[0];Object.assign(chat,{name:'整理周末出行准备',title:'整理周末出行准备',projectId:'qa-trip',workspace:'日常',messages:[],modelConfig:{provider:'api',model:'演示预设',effort:''}});
 const run={id:'demo-review',conversationId:chat.id,workspace:'日常',projectId:'qa-trip',goal:'整理出行准备，生成一份可继续编辑的清单。',steps:[],status:'completed',createdAt:now,completedAt:now,model:'演示预设'};
 state.agentRuns=[run];
 const results=executeActions([{type:'create_note',title:'出行准备清单',content:'# 出行准备清单\n\n> 把准备留在出发之前。\n\n## 出发前\n- 确认交通与住宿\n- 查看最新天气\n- 分享路线给同行伙伴\n\n## 随身装备\n- 饮水、补给与雨具\n- 充电设备和离线地图\n\n## 备用安排\n遇到恶劣天气时调整路线，不赶进度。',workspace:'日常',projectId:'qa-trip',sourceAttachmentIds:[]}],run);
 chat.messages=[{id:'demo-ask',role:'user',text:run.goal},{id:'demo-reply',role:'assistant',text:'已整理成出行准备清单。可以打开右侧阅读区，查看本轮新增内容，再继续补充。',runId:run.id,results}];
 state.currentConversationId=chat.id;
 normalizeStateShape(state);save();renderAll();return true;
})();
