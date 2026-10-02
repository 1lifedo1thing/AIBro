import React from 'react';
import {AbsoluteFill,Img,staticFile,useCurrentFrame} from 'remotion';
import actions from '../motion-v3/intro-actions.json';
import {LANG} from './motion-language.jsx';
import {SceneLead} from './motion-stage.jsx';
import {C,F,p,lerp,Native,Type,Label,Rule} from './motion-study.jsx';
import {nativeFrameAt} from './native-action-timing.mjs';
const A=Object.fromEntries(actions.sequences.map(s=>[s.id,s]));
const L=(lang,zh,en)=>lang==='en'?en:zh;
const sample=(id,clock)=>nativeFrameAt(A[id],clock);
const still=name=>({src:'assets/film/motion-v3/'+name+'.jpg',w:2560,h:1678});
export const INTRO_FRAMES=672;
export function MotionIntro({lang='zh'}){
 const t=useCurrentFrame()/60;
 let scene,caption;
 if(t<1.8){
  const source=sample('course-import-commit',t<.62?0:1930+(t-.62)*3300);
  scene=<>
   <SceneLead q={t} lang={lang} settled title={L(lang,'课件，变成复习笔记','Turn a lecture into study notes')} subtitle={L(lang,'导入原文件，整理重点和作业要求。','Import your source. Organize key points and assignments.')} size={88}/>
   <Native source={source} crop={t<.62?[900,1100,1280,410]:[900,1020,1280,560]} box={t<.62?lerp([370,491,1230,394],[235,450,1500,480],p(t,.3,.62)):lerp([235,423,1500,540],[185,398,1550,560],p(t,.62,1.2))} radius={20}/>
  </>;
  caption=L(lang,'添加课件 · 保存原文件','Add a source · Keep the original');
 }else if(t<4.8){
  const q=t-1.8, composing=q<1.2;
  const source=sample('course-send-process',q<.95?0:q<1.2?1400:2194+(q-1.2)*4700);
  scene=<>
   <SceneLead q={composing?q:q-1.2} lang={lang} title={L(lang,composing?'读课件，整理重点':'AI 阅读课件',composing?'Read the lecture. Find the key points.':'AI reads your source')} subtitle={L(lang,composing?'这一讲讲什么？有哪些作业？':'检查原文，起草一页复习笔记。',composing?'What does it cover? What is the assignment?':'Read the original. Draft a page of study notes.')} size={83}/>
   <Native source={source} crop={composing?[730,1184,1618,453]:[745,322,1580,740]} box={composing?lerp([220,448,1490,418],[104,404,1712,480],p(q,.35,.9)):lerp([306,425,1330,545],[210,381,1500,610],p(q,1.45,2.35))} radius={23}/>
  </>;
  caption=L(lang,composing?'整理一页复习笔记，列出作业要求。':'阅读课件 → 确认整理内容',composing?'A page of study notes and the assignment requirements.':'Read the lecture → review the plan');
 }else if(t<6.5){
  const q=t-4.8, source=sample('course-approve-delivery',q<.72?0:2000+(q-.72)*4400), delivered=q>=.72;
  scene=<>
   <SceneLead q={q} lang={lang} title={L(lang,'确认整理内容','Review the proposed notes')} subtitle={L(lang,'看清写入位置，再审阅生成的笔记。','Choose where to save, then review the draft.')} size={83}/>
   <Native source={source} crop={delivered?[745,463,1580,632]:[788,350,955,793]} box={delivered?[110,369,1700,600]:[625,333,1140,658]} radius={21}/>
   {!delivered&&<Type text={L(lang,'补充笔记。\n保留原文。','Add notes.\nKeep your writing.')} x={99} y={459} size={50} width={505}/>}
  </>;
  caption=L(lang,delivered?'复习笔记草稿 · 待审阅':'确认追加内容 · 保留原有笔记',delivered?'Study-note draft · Awaiting review':'Approve the addition · Keep your own notes');
 }else if(t<8.25){
  const q=t-6.5;
  scene=<>
   <SceneLead q={q} lang={lang} title={L(lang,'先看修改，再保存','Review changes before saving')} subtitle={L(lang,'新内容单独列出，原有笔记保留。','See the additions. Keep your original notes.')} size={82}/>
   <Native source={still('course-delivery-opened')} crop={lerp([885,535,1595,1040],[917,1035,1553,525],p(q,.25,1.2))} box={lerp([243,352,1434,610],[100,408,1720,550],p(q,.25,1.2))} radius={20}/>
  </>;
  caption=L(lang,'整理重点、作业要求和来源','Key points, assignment requirements, and sources');
 }else if(t<10.3){
  const q=t-8.25, source=sample('course-delivery-save',q<.4?0:1523+(q-.4)*2600);
  const accepted=q>=.4;
  scene=<>
   <SceneLead q={q} lang={lang} settled title={L(lang,accepted?'笔记已保存':'先看修改，再保存',accepted?'Your notes are saved':'Review changes before saving')} subtitle={L(lang,accepted?'保留原有内容，还可以直接编辑。':'新内容单独列出，原有笔记保留。',accepted?'Original content kept. Edit whenever you need.':'See the additions. Keep your original notes.')} size={82}/>
   {accepted?<>
    <Native source={source} crop={[599,630,287,74]} box={[98,340,574,148]} radius={14}/>
    <Native source={source} crop={[918,831,1553,720]} box={[755,330,1070,620]} radius={18}/>
    <Type text={L(lang,'核心方法。\n作业要求。\n截止时间。','Key methods.\nAssignment.\nDue date.')} x={101} y={528} size={57} width={585}/>
   </>:<Native source={source} crop={[910,538,1567,682]} box={[185,348,1550,623]} radius={18}/>}
  </>;
  caption=L(lang,accepted?'已采纳 · 新笔记已加入，原文保留':'审阅草稿 · 核对新增内容',accepted?'Accepted · New notes added, original text kept':'Review the draft · Check the additions');
 }else{
  scene=<>
   <div style={{position:'absolute',left:78,top:178,width:1764,height:702,background:C.sage,borderRadius:32}}/>
   <Type text={L(lang,'打开课程，\n查看笔记与作业。','Open the course.\nFind notes and assignments.')} x={140} y={286} size={106} width={1600}/>
   <Label x={148} y={680} size={29}>{L(lang,'课程里的笔记、任务和日程','Course notes, tasks, and calendar')}</Label>
  </>;
  caption=L(lang,'以下为同一虚构项目的多会话剪辑','The following scenes are edited across this fictional project’s sessions');
 }
 return <LANG.Provider value={lang}><AbsoluteFill style={{background:C.paper,color:C.ink,fontFamily:F,WebkitFontSmoothing:'antialiased'}}>
  {scene}
  <div style={{position:'absolute',left:76,top:40,display:'flex',alignItems:'center',gap:12,fontSize:30,fontWeight:600,letterSpacing:-.8}}><Img src={staticFile('assets/mark.png')} style={{width:36,height:36,borderRadius:9}}/>AI Bro</div>
  <Label x={1330} y={44} size={18}>{L(lang,'交互设计方法 · 课件与笔记','LECTURE → NOTES')}</Label>
  <Label x={99} y={998} size={21}>{caption}</Label>
  <div style={{position:'absolute',left:78,right:78,bottom:15,fontSize:14,color:C.muted,display:'flex',justifyContent:'space-between'}}><span>{L(lang,'原生 App 操作素材 · 原创虚构资料','Actual native App action captures · Fictional materials')}</span><span>{L(lang,'操作与等待经剪辑 · 非实时录屏','Actions and waits condensed · Not a real-time recording')}</span></div>
 </AbsoluteFill></LANG.Provider>;
}
