import React from 'react';
import {AbsoluteFill, Img, staticFile, useCurrentFrame} from 'remotion';
import manifest from '../workflow-manifest.json';
import nativeActions from '../motion-v3/native-actions.json';
import {nativeFrameAt} from './native-action-timing.mjs';
const ACTIONS=Object.fromEntries(nativeActions.sequences.map(s=>[s.id,s]));
import {LANG} from './motion-language.jsx';
import {SceneLead} from './motion-stage.jsx';
import {ResearchScene} from './motion-research.jsx';
import currentCaptures from '../motion-v3/capture-current.json';
import {editorialSourceFrame} from './motion-edit-timeline.mjs';
import {C,F,p,mix,lerp,Native,Type,Label,Rule,Hook,OpenSource,Assignment,Task,Methods,Save} from './motion-study.jsx';

export const FILM_FPS=60,FILM_SECONDS=75;
const index=Object.fromEntries(manifest.shots.flatMap(s=>[s,...(s.actualFrames||[])]).map(s=>[s.src.split('/').at(-1).replace(/\.(?:jpg|png)$/, ''),{src:s.src,w:s.width,h:s.height}]));
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
 // Keep the full native action row in frame while focusing the diff.
 // Both states share this crop so acceptance does not move the saved document.
 const overview=[887,529,1603,1102],focused=[887,862,1603,769];
 const crop=accepted?lerp(focused,overview,returning):lerp(overview,focused,detail);
 const box=accepted?lerp([674,387,1154,570],[694,264,1130,736],returning):lerp([724,316,1085,680],[674,387,1154,570],detail);
 return <>
  <SceneLead q={q} lang={lang} title={L(lang,'编辑笔记','Edit your notes')} subtitle={L(lang,'调整 AI 整理的内容，\n逐项确认修改。','Refine the AI draft.\nReview each change.')} x={90} y={178} width={555} subtitleWidth={520} size={91}/>
  <Native source={img(accepted?'course-diff-saved':'course-diff')} crop={crop} box={box} radius={18}/>
  <Rule x={97} y={596} w={420} k={p(q,.6,1.2)}/>
  <Type text={L(lang,accepted?'确认后，保存到笔记。':'先看哪里被修改。',accepted?'Accept and save.':'See what changed.')} x={98} y={646} size={43} width={505} reveal={accepted?p(q,2.25,2.6):p(q,.85,1.25)}/>
  <Label x={100} y={839} size={22}>{L(lang,accepted?'已采纳 · 原文保留':'待审阅的修改',accepted?'Accepted · Original kept':'Changes to review')}</Label>
 </>;
}
function Agenda({q,clock,lang}){
 const confirming=q>=2.65,saved=q>=5.75;
 // Only the captured states use the original source clock. The editorial camera
 // stays continuous across the removed source hold at full-film 31.6 seconds.
 const arrive=p(clock,.5,1.35),proposal=p(clock,1.3,2.15),reserve=p(clock,2.05,2.65);
 const resultMove=p(clock,5.2,6.25),requestExit=p(clock,4.95,5.2);
 // Match the actual visible Native frame, not merely its letterboxed container.
 // The new capture starts in the outgoing frame, then its crop opens to the
 // full review or result. There is never a blend of two readable screenshots.
 const anchor=[1085,390,720,720*415/1452],formEnter=p(clock,8/3,3.24);
 const formCrop=lerp([0,95,1140,1140*415/1452],[0,0,1140,1190],formEnter);
 const formXYW=lerp(anchor.slice(0,3),[1155,325,650],formEnter);
 const formBox=[...formXYW,formXYW[2]*formCrop[3]/formCrop[2]];
 const calendarCrop=lerp([570,585,884*1140/1190,884],[570,585,1930,460],resultMove);
 const calendarXYW=lerp([1155,325,650],[98,435,1724],resultMove);
 const calendarBox=[...calendarXYW,calendarXYW[2]*calendarCrop[3]/calendarCrop[2]];
 const requestBox=lerp(lerp([468,463,1320,168],[110,382,1698,216],arrive),[96,375,910,115.4],reserve);
 requestBox[0]-=1100*requestExit;
 return <>
  <SceneLead q={clock} lang={lang} title={L(lang,'一句话，安排日程','Plan it in one sentence')} subtitle={L(lang,'说清时间和事项，确认后加入课程。','Say when and what. Review before adding it.')} x={95} y={140} size={78}/>
  <Native source={img('agenda-question')} crop={[1143,263,1159,147]} box={requestBox} radius={20} style={{opacity:1-requestExit}}/>
  {!confirming&&<Native source={img('agenda-proposal')} crop={[755,700,1452,415]}
   box={lerp(lerp([1040,1088,778,223],[800,660,1015,290],proposal),anchor,reserve)} radius={22}/>}
  {confirming&&!saved&&<Native source={img('agenda-save')} crop={formCrop} box={formBox} radius={22}/>}
  {confirming&&<div style={{opacity:1-requestExit}}>
   <Label x={101} y={566} size={24}>{L(lang,'核对请求中的安排','Check the requested details')}</Label>
   <Type text={L(lang,'15:00–15:20\n二十分钟校园观察','3:00–3:20 p.m.\nCampus observation')} x={98} y={621} size={55} width={975} reveal={p(clock,2.67,3.07)}/>
   <Label x={101} y={795} size={25}>{L(lang,'课程：交互设计方法','Course: Interaction Design Methods')}</Label>
  </div>}
  {saved&&<>
   <Native source={img('agenda-calendar')} crop={calendarCrop} box={calendarBox} radius={22}/>
   <Label x={102} y={961} size={25} style={{opacity:p(clock,6.35,6.65)}}>{L(lang,'15:00 · 校园观察，已加入日程。','3 p.m. · Campus observation is on the calendar.')}</Label>
  </>}
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
 const editing=q>=1.4,saved=q>=4.65;
 const source=currentCaptures.sources[saved?'saved':editing?'edit':'context'];
 // One real record keeps its position when the captured App changes mode.
 // Move the editorial camera only after that cut; never invent intermediate UI.
 const overview=[18,78,1484,884],detail=[536,326,966,636],result=[536,326,966,482];
 const overviewBox=[698,265,1130,706],detailBox=[674,285,1150,735],resultBox=[674,340,1150,598];
 const focus=p(q,1.65,2.7),land=p(q,4.85,5.6);
 const crop=saved?lerp(detail,result,land):editing?lerp(overview,detail,focus):overview;
 const box=saved?lerp(detailBox,resultBox,land):editing?lerp(overviewBox,detailBox,focus):overviewBox;
 return <>
  <SceneLead q={q} lang={lang} title={L(lang,'补充现场观察','Add to your\nobservations')} subtitle={L(lang,'打开原随记，补记细节，\n保留已有内容。','Open your saved note.\nAdd detail. Keep the original.')} x={90} y={166} width={580} subtitleWidth={535} size={81}/>
  <Native source={source} crop={crop} box={box} radius={20}/>
  <Type text={L(lang,saved?'观察已更新':'先记事实，\n再写感受。',saved?'Observation updated':'Record facts.\nThen impressions.')} x={98} y={581} size={49} width={527} reveal={saved?p(q,4.65,5):p(q,.55,1.05)}/>
  <Rule x={101} y={755} w={430} k={p(q,1.05,1.7)}/>
  <Label x={101} y={798} size={21} style={{width:500}}>{L(lang,saved?'原文与已有成果保留':'编辑已保存的原始随记',saved?'Original text and linked work kept':'Edit the original saved note')}</Label>
 </>;
}
function Connect({q,lang}){
 if(q<3.7){const reviewing=q<2.1;return <>
  <SceneLead q={q} lang={lang} title={L(lang,'让随记接上课程','Connect notes to your course')} subtitle={L(lang,'回看之前的关联与整理，原始记录仍保留。','Review the earlier association. The original note is preserved.')} y={135} size={76}/>
  {/* Preserve the captured review / accepted cut. Focus the actual project fields,
      then show the saved note's course breadcrumb together with its original text. */}
  <Label x={112} y={307} size={23}>{L(lang,reviewing?'此前的关联审阅':'此前已采纳 · 课程归属与原始记录',reviewing?'Earlier association review':'Previously accepted · Course and original note')}</Label>
  <Native source={img(reviewing?'capture-project-review':'capture-project-saved')}
   crop={reviewing?[780,618,1145,531]:[550,405,1986,600]}
   box={reviewing?[263,356,1394,646.5]:[110,375,1700,513.6]} radius={20}/>
 </>;}
 // Keep all six complete questions visible throughout one brief editorial push.
 // The source IDs above and below this passage remain outside the unaltered crop.
 const focus=p(q,4.2,4.8);return <>
  <SceneLead q={q-3.7} lang={lang} title={L(lang,'随手观察，整理成六个问题','Six questions for your next observation')} subtitle={L(lang,'此前整理的观察问题，已保存在课程笔记中。','The earlier synthesis is saved in the course notes.')} y={135} size={76}/>
  <Native source={img('capture-integrated')} crop={[642,620,1840,708]}
   box={lerp([155,365,1610,619.5],[102,347,1716,660.3],focus)} radius={18}/>
 </>;
}
// The saved task gives semantic continuity while its surrounding UI stays readable.
// This remains an editorial return to the course, not a fabricated island click.
function TaskReturnLead({lang,q=0,settled=false}){return <SceneLead q={q} settled={settled} lang={lang} title={L(lang,'回到课程，查看任务','Return to your course tasks')} subtitle={L(lang,'笔记与待办，保存在同一个课程中。','Your notes and tasks, saved in the same course.')} size={81}/>;}
function Island({q,clock,lang}){
 const compact=ACTIONS['island-compact-tasks'];
 const collapsed=q<1.1;
 // One disclosed editorial cut into the captured task panel, not fabricated expansion.
 const source=collapsed?nativeFrameAt(ACTIONS['island-compact-collapsed'],0):nativeFrameAt(compact,Math.max(550,(q-.65)*1000),{initialHoldMs:550});
 const focus=p(q,2.15,4.45),returnLead=clock>=5.7;
 const baseCrop=lerp([0,0,1520,1040],[32,548,1448,373],focus),baseBox=lerp([580,371,760,520],[244,490,1432,369],focus);
 const crop=collapsed?[0,0,source.w,source.h]:baseCrop;
 const box=collapsed?[835.5,371,249,39]:baseBox;
 return <>
  {returnLead?<TaskReturnLead lang={lang} q={clock-5.7}/>:<SceneLead q={q} lang={lang} title={L(lang,'待办，就在屏幕顶部','Your tasks, at the top of your screen')} subtitle={L(lang,'查看课程任务，不用先找主窗口。','Check course tasks without finding the main window.')} size={81}/>}
  {/* The border explains position. It is not a simulated desktop recording. */}
  <div style={{position:'absolute',left:124,top:370,width:1672,height:558,border:'2px solid #bdc7c0',borderRadius:24,background:'rgba(255,255,255,.22)',opacity:1-focus*.78}}/>
  <div style={{position:'absolute',left:835.5,top:369,width:249,height:4,background:C.ink,borderRadius:3,opacity:1-focus}}/>
  <Native source={source} crop={crop} box={box} radius={collapsed?0:22} shadow={!collapsed}/>
  <Label x={132} y={975} size={22}>{L(lang,'屏幕位置示意 · 实际 App 画面剪辑','Screen-position illustration · Edited actual App captures')}</Label>
 </>;
}
function Project({q,lang}){
 const detail=q>=3.05-1e-6,focus=p(q,.7,1.55),checklist=p(q,3.65,4.65);
 // Hold the whole course context before one short move toward its task list.
 // The detail enters complete, then the camera lands on all five checklist rows.
 const crop=detail?lerp([797,139,1480,1500],[824,1048,1438,447],checklist):lerp([549,599,1950,562],[1620,599,890,562],focus);
 const box=detail?lerp([621,319,678,682],[238,440,1460,456.9],checklist):lerp([96,407,1730,498.6],[482,398,1284,600],focus);
 return <>
  {detail?<SceneLead settled lang={lang} title={L(lang,'打开观察任务，查看清单','Open the task. Review the checklist.')} subtitle={L(lang,'候车时间、手机次数、主观感受——逐项记录。','Record waiting time, phone checks, and how the wait felt.')} size={81}/>:<TaskReturnLead lang={lang} settled/>}
  <Native source={img(detail?'project-next-task-current':'project-next')} crop={crop} box={box} radius={22}/>
  <Label x={105} y={975} size={22}>{L(lang,detail?'既有任务 · 五项待完成检查':'回到课程总览 · 查看已保存的成果与任务',detail?'Existing task · Five unchecked steps':'Course overview · Saved notes and tasks')}</Label>
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
 else if(t<4.5)scene=<OpenSource t={t} leadQ={t-2.2+.9}/>;
 else if(t<7.3)scene=<Assignment t={t}/>;
 else if(t<10.15)scene=<Task t={t}/>;
 else if(t<12.65)scene=<Methods t={t}/>;
 else if(t<17)scene=<Review q={t-12.65} lang={lang}/>;
 else if(t<20.1)scene=<Save t={t-17+12.65}/>;
 else if(t<29)scene=<Agenda q={t-20.1} clock={(frame-1140)/FILM_FPS} lang={lang}/>;
 // The edited research chapter has a continuous clock across former hold cuts.
 // Body frame 1626 maps to full-film frame 2166 (36.1 seconds).
 else if(t<50)scene=<ResearchScene q={(frame-1626)/FILM_FPS} lang={lang}/>;
 else if(t<57)scene=<Capture q={t-50} lang={lang}/>;
 else if(t<65)scene=<Connect q={t-57} lang={lang}/>;
 else if(t<72)scene=<Island q={t-65} clock={(frame-3534)/FILM_FPS} lang={lang}/>;
 else if(t<78)scene=<Project q={t-72} lang={lang}/>;
 else scene=<Finish q={t-78} lang={lang}/>;
 return <LANG.Provider value={lang}><AbsoluteFill style={{background:C.paper,color:C.ink,fontFamily:F,WebkitFontSmoothing:'antialiased'}}>
  {scene}<Head lang={lang} t={t}/>
 </AbsoluteFill></LANG.Provider>;
}
