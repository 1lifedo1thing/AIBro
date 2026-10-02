import React from 'react';
import {AbsoluteFill, Img, staticFile, useCurrentFrame} from 'remotion';
import manifest from '../workflow-manifest.json';
import nativeActions from '../motion-v3/native-actions.json';
import {nativeFrameAt} from './native-action-timing.mjs';
const ACTIONS=Object.fromEntries(nativeActions.sequences.map(s=>[s.id,s]));
import {LANG} from './motion-language.jsx';
import {SceneLead} from './motion-stage.jsx';
import {editorialSourceFrame} from './motion-edit-timeline.mjs';
import {C,F,p,mix,lerp,Native,Type,Label,Rule,Hook,OpenSource,Assignment,Task,Methods,Save} from './motion-study.jsx';

export const FILM_FPS=60,FILM_SECONDS=75;
const index=Object.fromEntries(manifest.shots.flatMap(s=>[s,...(s.actualFrames||[])]).map(s=>[s.src.split('/').at(-1).replace(/\.jpg$/, ''),{src:s.src,w:s.width,h:s.height}]));
const img=(id)=>index[id]||{src:`assets/film/workflow/${id}.jpg`,w:id.startsWith('island-')?840:2560,h:id.startsWith('island-')?1126:1678};
const L=(lang,zh,en)=>lang==='en'?en:zh;
const MAIN=[524,105,1990,1450];
function Head({lang,t}){return <>
 <div style={{position:'absolute',left:76,top:40,display:'flex',alignItems:'center',gap:12,fontSize:30,fontWeight:600,letterSpacing:-.8}}><Img src={staticFile('assets/mark.png')} style={{width:36,height:36,borderRadius:9}}/>AI Bro</div>
 <Label x={1340} y={44} size={18}>{L(lang,t<29?'交互设计方法 · 笔记与任务':t<50?'城市低碳交通 · 资料查询':t<74?'随手记 · 课程与待办':'AI Bro · 学习与研究助手',t<29?'COURSE NOTES & TASKS':t<50?'RESEARCH & SOURCES':t<74?'QUICK NOTES & TASKS':'AI FOR STUDY & RESEARCH')}</Label>
 <div style={{position:'absolute',left:78,right:78,bottom:27,display:'flex',justifyContent:'space-between',fontSize:16,color:C.muted}}><span>{L(lang,'原生 App 画面 · 原创虚构资料 · 多会话剪辑','Native App captures · Fictional materials · Edited across sessions')}</span><span>{L(lang,'开发预览 · 操作与等待经剪辑','Development preview · Actions and waiting condensed')}</span></div>
 </>;}
function Review({q,lang}){
 const accepted=q>=2.25,detail=p(q,.6,1.65),returning=p(q,2.25,3.05);
 const crop=accepted?lerp([887,835,1603,735],[887,529,1603,1102],returning):lerp([887,529,1603,1102],[887,835,1603,735],detail);
 const box=accepted?lerp([674,387,1154,570],[694,264,1130,736],returning):lerp([724,316,1085,680],[674,387,1154,570],detail);
 return <>
  <SceneLead q={q} lang={lang} title={L(lang,'编辑笔记','Edit your notes')} subtitle={L(lang,'调整 AI 整理的内容，\n逐项确认修改。','Refine the AI draft.\nReview each change.')} x={90} y={178} width={555} subtitleWidth={520} size={91}/>
  <Native source={img(accepted?'course-diff-saved':'course-diff')} crop={crop} box={box} radius={18}/>
  <Rule x={97} y={596} w={420} k={p(q,.6,1.2)}/>
  <Type text={L(lang,accepted?'确认后，保存到笔记。':'先看哪里被修改。',accepted?'Accept and save.':'See what changed.')} x={98} y={646} size={43} width={505} reveal={accepted?p(q,2.25,2.6):p(q,.85,1.25)}/>
  <Label x={100} y={839} size={22}>{L(lang,accepted?'已采纳 · 原文保留':'待审阅的修改',accepted?'Accepted · Original kept':'Changes to review')}</Label>
 </>;
}
function Agenda({q,lang}){
 if(q<2.65){const aim=p(q,.5,1.35),proposal=p(q,1.3,2.15);return <>
  <SceneLead q={q} lang={lang} title={L(lang,'一句话，安排日程','Plan it in one sentence')} subtitle={L(lang,'说清时间和事项，确认后加入课程。','Say when and what. Review before adding it.')} size={86}/>
  <Native source={img('agenda-question')} crop={[1143,263,1159,147]} box={lerp([468,463,1320,168],[110,382,1698,216],aim)} radius={23}/>
  <Native source={img('agenda-proposal')} crop={[755,700,1452,415]} box={lerp([1040,1088,778,223],[800,660,1015,290],proposal)} radius={18}/>
  <Label x={112} y={722} size={27} style={{opacity:proposal}}>{L(lang,'日期、时间、所属课程。','Date. Time. Course.')}</Label>
 </>;}
 if(q<5.75){const k=p(q,2.9,4.7);return <>
  <SceneLead q={q-2.65} lang={lang} title={L(lang,'确认时间','Check the time')} subtitle={L(lang,'下午三点，安排二十分钟校园观察。','3 p.m. A twenty-minute observation.')} x={90} y={199} width={915} size={95}/>
  <Native source={img('agenda-save')} crop={[0,0,1140,1380]} box={lerp([1165,305,555,672],[1056,138,715,865],k)} radius={27}/>
  <Type text={L(lang,'确认后保存。','Confirm and save.')} x={98} y={626} size={56} width={815} reveal={p(q,3.25,3.7)}/>
  <Rule x={98} y={736} w={690} k={p(q,3.4,4.05)}/>
 </>;}
 const k=p(q,6.2,7.45);return <>
  <SceneLead q={q-5.75} lang={lang} title={L(lang,'校园观察，排好了','Your observation is scheduled')} subtitle={L(lang,'回到课程，就能查看任务和日程。','Find your tasks and calendar in the course.')} size={85}/>
  <Native source={img('agenda-calendar')} crop={lerp([569,162,1930,912],[570,525,1930,512],k)} box={lerp([310,425,1420,534],[98,428,1724,457],k)} radius={23}/>
 </>;
}
function Research({q,lang}){
 if(q<3.6)return <>
  <SceneLead q={q} lang={lang} title={L(lang,'读研究资料，\n抓住重点','Read a study.\nFind what matters.')} subtitle={L(lang,'询问研究方法、关键数据和结论。','Ask about the method, data, and findings.')} x={88} y={171} width={1350} size={85}/>
  <Native source={img('paper-question')} crop={[730,1240,1615,408]} box={lerp([1080,647,738,232],[596,558,1240,390],p(q,.65,1.8))} radius={22}/>
  <Rule x={99} y={712} w={355} k={p(q,1.05,1.85)}/>
 </>;
 if(q<7.4){const k=p(q,4.2,5.25),numbers=q>=5.5;return <>
  <SceneLead q={q-3.6} lang={lang} title={L(lang,'方法、数据、\n局限','Methods. Data.\nLimitations.')} subtitle={L(lang,'整理成附有来源的研究笔记。','Research notes with their sources.')} x={89} y={180} width={585} size={80}/>
  <Native source={img(numbers?'paper-analysis-numbers':'paper-analysis')} crop={numbers?[541,944,1650,510]:[541,583,1970,962]} box={numbers?lerp([715,433,1110,462],[650,401,1175,475],p(q,5.5,6.55)):lerp([795,380,1015,575],[680,326,1145,661],k)} radius={20}/>
  <Label x={100} y={746} size={22} style={{width:505}}>{L(lang,'画面数据为原创合成示例。','The figures shown are synthetic examples.')}</Label>
 </>;}
 const k=p(q,7.8,8.65);return <>
  <SceneLead q={q-7.4} lang={lang} title={L(lang,'读过的资料，也能问回来','Ask about a source you read before')} subtitle={L(lang,'不用记住文件名，描述你记得的内容。','Describe what you remember. No filename needed.')} size={82}/>
  <Native source={img('paper-recall')} crop={[969,266,1340,188]} box={lerp([348,620,1370,192],[114,479,1640,230],k)} radius={25}/>
 </>;
}
function Recall({q,lang}){
 if(q<3.45){const k=p(q,.65,2.25);return <>
  <SceneLead q={q} lang={lang} title={L(lang,'答案有出处','Answers with sources')} subtitle={L(lang,'查回研究结论，再核对原始页码。','Find the result, then check its original page.')} size={86}/>
  <Native source={img('paper-recall')} crop={lerp([735,738,1595,610],[735,1150,1595,118],k)} box={lerp([148,389,1610,600],[109,524,1700,260],k)} radius={23}/>
  <Label x={116} y={950} size={23}>{L(lang,'结论、来源与适用范围','Findings, sources, and limitations')}</Label>
 </>;}
 const preview=q<5.85;
 const frame=preview?nativeFrameAt(ACTIONS['citation-open-real'],(q-3.45)*1000,{initialHoldMs:300}):nativeFrameAt(ACTIONS['citation-source-real'],(q-5.85)*1000,{initialHoldMs:300});
 const detail=p(q,7.8,8.5);
 return <>
  <SceneLead q={preview?q-3.45:q-5.85} lang={lang} title={L(lang,preview?'点开引用，查看出处':'打开原文，核对数据',preview?'Open the citation':'Check the original')} subtitle={L(lang,preview?'先看来源预览与引用页码。':'让结论和原文中的表格对得上。',preview?'See the source preview and page reference.':'Compare the answer with the source table.')} size={82}/>
  <Native source={frame} crop={preview?[725,388,1600,594]:lerp([530,200,2010,1140],[726,1178,1608,390],detail)} box={preview?[95,400,1730,535]:lerp([95,366,1730,611],[220,468,1480,360],detail)} radius={16}/>
  <Label x={105} y={996} size={21}>{L(lang,preview?'来源预览 · 第 2 页':'原文第 2 / 3 页 · 合成示例数据',preview?'Source preview · Page 2':'Source page 2 of 3 · Synthetic example data')}</Label>
 </>;
}
function Capture({q,lang}){
 const source=img(q<1.1?'quick-entry':q<2.2?'quick-note-input':q<4.65?'quick-note':'quick-saved');
 const focus=p(q,2.35,3.35),saved=p(q,4.65,5.55);
 return <>
  <SceneLead q={q} lang={lang} title={L(lang,'随手记下观察','Capture an observation')} subtitle={L(lang,'先记下想法，再决定放进哪门课。','Write it down. Organize it into a course later.')} x={90} y={183} width={1570} size={86}/>
  {q<2.2?<Native source={source} crop={[25,80,790,380]} box={lerp([978,482,835,402],[840,400,970,467],p(q,.6,1.45))} radius={18}/>:q<4.65?<>
   <Native source={source} crop={[25,290,790,126]} box={lerp([790,448,1030,164],[750,411,1070,171],focus)} radius={15}/>
   <Native source={source} crop={[25,808,790,226]} box={lerp([880,1070,940,269],[750,651,1070,306],p(q,2.7,3.65))} radius={18}/>
  </>:<Native source={source} crop={[25,476,790,551]} box={lerp([1010,404,815,568],[895,367,875,610],saved)} radius={20}/>}
  <Type text={L(lang,q>=4.65?'随记已保存':'候车时间、\n查看手机的次数……',q>=4.65?'Quick note saved':'Waiting time.\nChecking a phone…')} x={101} y={550} size={48} width={600} reveal={q>=4.65?p(q,4.65,5.15):p(q,.6,1.1)}/>
  <Rule x={101} y={764} w={468} k={p(q,1.15,1.9)}/>
 </>;
}
function Connect({q,lang}){
 if(q<3.7){const k=p(q,.6,1.8);return <>
  <SceneLead q={q} lang={lang} title={L(lang,'把随记放回课程','Add it to your course')} subtitle={L(lang,'关联已有项目，保留原始记录。','Link an existing project. Keep the original note.')} x={87} y={180} width={925} size={86}/>
  <Native source={img(q<2.1?'capture-project-review':'capture-project-saved')} crop={q<2.1?[753,336,1178,806]:[555,387,1890,740]} box={lerp([990,400,830,570],[820,345,1005,645],k)} radius={20}/>
  <Rule x={99} y={625} w={516} k={p(q,.8,1.55)}/>
  <Label x={100} y={738} size={24}>{L(lang,q<2.1?'待审阅的关联':'已采纳',q<2.1?'Review the association':'Accepted')}</Label>
 </>;}
 const k=p(q,4.25,6.85);return <>
  <SceneLead q={q-3.7} lang={lang} title={L(lang,'观察问题，补进课程笔记','Add your questions to the course notes')} subtitle={L(lang,'保留已有内容，把这次观察也整理进去。','Keep your notes and add the new observations.')} size={81}/>
  <Native source={img('capture-integrated')} crop={lerp([626,424,1828,876],[644,618,1770,255],k)} box={lerp([282,389,1356,583],[105,501,1710,338],k)} radius={18}/>
 </>;
}
function Island({q,lang}){
 const compact=ACTIONS['island-compact-tasks'];
 const collapsed=q<1.1;
 // One disclosed editorial cut into the captured task panel, not fabricated expansion.
 const source=collapsed?nativeFrameAt(ACTIONS['island-compact-collapsed'],0):nativeFrameAt(compact,Math.max(550,(q-.65)*1000),{initialHoldMs:550});
 const focus=p(q,2.15,4.45);
 const crop=collapsed?[0,0,source.w,source.h]:lerp([0,0,1520,1040],[32,548,1448,373],focus);
 const box=collapsed?[835.5,371,249,39]:lerp([580,371,760,520],[244,490,1432,369],focus);
 return <>
  <SceneLead q={q} lang={lang} title={L(lang,'待办，就在屏幕顶部','Your tasks, at the top of your screen')} subtitle={L(lang,'查看课程任务，不用先找主窗口。','Check course tasks without finding the main window.')} size={81}/>
  {/* The border explains position. It is not a simulated desktop recording. */}
  <div style={{position:'absolute',left:124,top:370,width:1672,height:558,border:'2px solid #bdc7c0',borderRadius:24,background:'rgba(255,255,255,.22)',opacity:1-focus*.78}}/>
  <div style={{position:'absolute',left:835.5,top:369,width:249,height:4,background:C.ink,borderRadius:3,opacity:1-focus}}/>
  <Native source={source} crop={crop} box={box} radius={collapsed?0:22} shadow={!collapsed}/>
  <Label x={132} y={975} size={22}>{L(lang,'屏幕位置示意 · 实际 App 画面剪辑','Screen-position illustration · Edited actual App captures')}</Label>
 </>;
}
function Project({q,lang}){
 const detail=q>=3.05,k=p(q,detail?3.05:.4,detail?4.7:2.1);
 return <>
  <Type text={L(lang,detail?'打开任务，查看具体要求。':'打开课程，\n查看笔记和待办。',detail?'Open a task. Check the requirements.':'Open the course.\nFind your notes and tasks.')} x={85} y={153} size={87} width={1740} reveal={p(q,detail?3.05:0,detail?3.4:.4)}/>
  <Native source={img(detail?'project-next-task':'project-next')} crop={detail?lerp([824,156,1438,1364],[824,887,1438,470],k):lerp([540,266,1970,950],[549,599,1950,562],k)} box={detail?lerp([693,318,1070,672],[238,404,1460,575],k):lerp([96,430,1730,581],[96,434,1730,532],k)} radius={22}/>
 </>;
}

function Finish({q,lang}){return <>
 <div style={{position:'absolute',left:78,top:168,width:1764,height:736,background:C.sage,borderRadius:34,clipPath:`inset(0 ${mix(100,0,p(q,0,.65))}% 0 0 round 34px)`}}/>
 <Type text={L(lang,'Mac 上的\nAI 学习与研究助手。','Your AI study and\nresearch assistant for Mac.')} x={140} y={224} size={113} width={1540} reveal={1}/>
 <div style={{position:'absolute',left:144,top:659,fontSize:43,fontWeight:540,color:C.green,opacity:p(q,.55,1)}}>{L(lang,'拿一份资料，试试 AI Bro','Try AI Bro with your own material')} <span style={{marginLeft:42}}>↗</span></div>
 <Label x={148} y={741} size={26} color={C.ink} style={{opacity:p(q,.8,1.25)}}>zihenghe04.github.io/AIBro</Label>
 </>;}
export function MotionFilm({lang='zh',withAudio=false}){
 const frame=useCurrentFrame(),t=editorialSourceFrame(frame,FILM_FPS)/FILM_FPS;
 let scene;
 if(t<2.2)scene=<Hook t={t}/>;
 else if(t<4.5)scene=<OpenSource t={t}/>;
 else if(t<7.3)scene=<Assignment t={t}/>;
 else if(t<10.15)scene=<Task t={t}/>;
 else if(t<12.65)scene=<Methods t={t}/>;
 else if(t<17)scene=<Review q={t-12.65} lang={lang}/>;
 else if(t<20.1)scene=<Save t={t-17+12.65}/>;
 else if(t<29)scene=<Agenda q={t-20.1} lang={lang}/>;
 else if(t<40)scene=<Research q={t-29} lang={lang}/>;
 else if(t<50)scene=<Recall q={t-40} lang={lang}/>;
 else if(t<57)scene=<Capture q={t-50} lang={lang}/>;
 else if(t<65)scene=<Connect q={t-57} lang={lang}/>;
 else if(t<72)scene=<Island q={t-65} lang={lang}/>;
 else if(t<78)scene=<Project q={t-72} lang={lang}/>;
 else scene=<Finish q={t-78} lang={lang}/>;
 return <LANG.Provider value={lang}><AbsoluteFill style={{background:C.paper,color:C.ink,fontFamily:F,WebkitFontSmoothing:'antialiased'}}>
  {scene}<Head lang={lang} t={t}/>
 </AbsoluteFill></LANG.Provider>;
}
