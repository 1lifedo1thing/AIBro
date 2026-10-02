import React from 'react';
export const LANG=React.createContext('zh');
const EN={
  "导入课件，\n整理复习笔记。": "Import a lecture.\nMake study notes.",
  "阅读资料，整理笔记，安排任务。": "Read sources. Write notes. Plan tasks.",
  "向课件提问": "Ask about the lecture",
  "打开原文，\n核对作业要求。": "Open the source.\nCheck the assignment.",
  "打开已保存的课件": "Open the saved lecture",
  "查看第 2 页的作业要求。": "Read the assignment on page 2.",
  "课件里的作业，\n整理成课程任务。": "Turn the assignment\ninto a course task.",
  "原文 · 第 2 页 · 作业要求": "Source · Page 2 · Assignment",
  "查看课程任务。": "Open the course task.",
  "课程任务 · 已保存": "Course task · Saved",
  "作业要求，\n列成检查清单。": "Assignment\nchecklist.",
  "观察 · 原型 · 笔记 · 反馈": "Observe · Prototype · Note · Feedback",
  "逐项查看任务要求。": "Check each assignment requirement.",
  "把课件里的方法整理成笔记。": "Turn lecture methods into notes.",
  "原文 · 第 1 页": "Source · Page 1",
  "课程笔记 · 四步框架": "Course notes · Four-step framework",
  "整理「观察、定义、原型、验证」四个步骤。": "Four steps: observe, define, prototype, test.",
  "补上自己的观察计划。": "Add your own observation plan.",
  "手动编辑 · 保存课程笔记": "Edit and save your course notes",
  "观察计划已写进课程笔记。": "Your observation plan is saved in the notes.",
  "Mac 上的\nAI 学习与研究助手。": "Your AI study and\nresearch assistant for Mac."
};
export const translate=(text,lang)=>lang==='en'?(EN[text]||text):text;
