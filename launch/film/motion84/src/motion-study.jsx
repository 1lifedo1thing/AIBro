import React from 'react';
import {LANG,translate} from './motion-language.jsx';
import {SceneLead} from './motion-stage.jsx';
import {AbsoluteFill, Img, interpolate, Easing, staticFile, useCurrentFrame} from 'remotion';
import actions from '../motion-v3/native-actions.json';
import {nativeFrameAt} from './native-action-timing.mjs';

// Film typography and crop movement are editorial. Every product pixel is native.
// Scenes switch opaquely; source text never dissolves over another source.
export const STUDY_FPS=60, STUDY_SECONDS=19;
const C={paper:'#f7f5ee',ink:'#153c32',green:'#176650',sage:'#e1e9db',line:'#b6c8bb',muted:'#55695e',white:'#fffefa'};
const F='"PingFang SC", "Helvetica Neue", Arial, sans-serif';
const ease=Easing.bezier(.22,.8,.18,1);
const p=(t,a,b)=>interpolate(t,[a,b],[0,1],{easing:ease,extrapolateLeft:'clamp',extrapolateRight:'clamp'});
const mix=(a,b,k)=>a+(b-a)*k, lerp=(a,b,k)=>a.map((v,i)=>mix(v,b[i],k));
const S=Object.fromEntries(Object.entries({page1:'course-import-opened.jpg',page2:'course-evidence-page2.jpg',note:'course-result.jpg',task:'course-task-detail.jpg',question:'course-question.jpg'}).map(([k,src])=>[k,{src:'assets/film/workflow/'+src,w:2560,h:k.startsWith('page')?1678:1686}]));
const sequences=Object.fromEntries(actions.sequences.map(s=>[s.id,s]));
const PAGE=[1075,373,930,1184], ASSIGNMENT=[1120,684,835,693];

function Native({source,crop,box,radius=14,shadow=true,rotate=0,style={}}){
 const [x,y,w,h]=box,[cx,cy,cw,ch]=crop;
 const sc=Math.min(w/cw,h/ch),iw=cw*sc,ih=ch*sc;
 return <div data-native-source={source.src} style={{position:'absolute',left:x,top:y,width:w,height:h,transform:`rotate(${rotate}deg)`,...style}}>
  <div style={{position:'absolute',left:(w-iw)/2,top:(h-ih)/2,width:iw,height:ih,overflow:'hidden',borderRadius:radius,background:C.white,boxShadow:shadow?'0 28px 70px -35px #17372b50, 0 0 0 1px #17372b10':'none'}}>
   <Img src={staticFile(source.fullSrc||source.src)} style={{position:'absolute',width:source.w*sc,height:source.h*sc,maxWidth:'none',left:-cx*sc,top:-cy*sc}}/>
  </div>
 </div>;
}
function Type({text,x,y,size=86,width=1300,reveal=1,color=C.ink,weight=570}){
 const lang=React.useContext(LANG); text=translate(text,lang); size=lang==='en'?size*.84:size;
 return <div style={{position:'absolute',left:x,top:y,width,fontSize:size,fontWeight:weight,letterSpacing:-size*.035,lineHeight:1.14,color,whiteSpace:'pre-line',overflow:'hidden'}}>
  <div style={{transform:reveal===1?undefined:`translateY(${(1-reveal)*112}%)`}}>{text}</div>
 </div>;
}
function Label({children,x,y,size=22,color=C.muted,style={}}){const lang=React.useContext(LANG);children=typeof children==='string'?translate(children,lang):children;return <div style={{position:'absolute',left:x,top:y,fontSize:size,lineHeight:1.4,letterSpacing:.1,color,...style}}>{children}</div>;}
function Rule({x,y,w,k=1}){return <div style={{position:'absolute',left:x,top:y,width:w,height:2,background:C.line,transform:`scaleX(${k})`,transformOrigin:'left'}}/>;}
function Shell(){return <>
 <div style={{position:'absolute',left:76,top:40,display:'flex',alignItems:'center',gap:12,fontSize:30,fontWeight:600,letterSpacing:-.8}}><Img src={staticFile('assets/mark.png')} style={{width:36,height:36,borderRadius:9}}/>AI Bro</div>
 <Label x={1440} y={45} size={19}>交互设计方法 · 第一讲</Label>
 <div style={{position:'absolute',left:78,right:78,bottom:28,display:'flex',justifyContent:'space-between',fontSize:17,color:C.muted}}><span>真实 App 素材 · 原创虚构课程 · 多会话剪辑</span><span>操作等待已压缩 · 动效方向样片</span></div>
 </>;}
function Hook({t}){
 const k=p(t,.45,1.8);
 return <>
  <Type text={'导入课件，\n整理复习笔记。'} x={90} y={186} size={126} width={1000} reveal={1}/>
  <Label x={98} y={530} size={30}>阅读资料，整理笔记，安排任务。</Label>
  <Native source={S.page1} crop={PAGE} box={[1260-mix(0,45,k),123,435,554]} rotate={mix(9,3,k)}/>
  <Native source={S.question} crop={[712,1090,1630,545]} box={lerp([1980,580,1440,445],[345,580,1440,445],p(t,.38,1.24))} radius={24}/>
  <Label x={91} y={758} size={20}>向课件提问</Label>
  <Rule x={94} y={800} w={190} k={p(t,.8,1.5)}/>
 </>;
}
function OpenSource({t,leadQ}){
 const lang=React.useContext(LANG),q=t-2.2,action=nativeFrameAt(sequences['pdf-open-real'],q*1000,{initialHoldMs:340,speed:1});
 const zoom=p(q,.6,1.7);
 return <>
  <SceneLead q={leadQ??q} lang={lang} title={lang==='en'?'Check the assignment\nin the source':'回到原文，\n核对作业'} subtitle={lang==='en'?'Open the saved lecture.\nRead the assignment on page 2.':'打开保存的课件，\n核对第 2 页的作业要求。'} x={1322} y={232} width={532} size={75}/>
  <Native source={action} crop={lerp([518,112,2035,1490],[550,245,1960,1390],zoom)} box={lerp([213,291,1002,687],[84,150,1185,862],zoom)} radius={20}/>
  <Rule x={1327} y={694} w={422} k={p(q,.85,1.5)}/>
 </>;
}
// Assignment and Task share one editorial camera clock. The saved task stays
// registered at the chapter boundary; this does not simulate a new App action.
function AssignmentFlow({t}){
 const lang=React.useContext(LANG),q=t-4.5;
 const arrive=p(q,.75,1.7),focus=p(q,2.9,3.65);
 const sourceExit=p(q,2.9,3.3);
 const taskBox=lerp(lerp([1950,345,794,660],[1030,345,794,660],arrive),[210,348,1500,647.5],focus);
 const taskCrop=lerp([810,320,1420,1180],[824,902,1390,600],focus);
 return <>
  <Type text={lang==='en'?'Turn the assignment into a checklist.':'课件里的作业，列成可执行的清单。'} x={90} y={136} size={80} width={1740} reveal={p(q,0,.36)}/>
  <Label x={95} y={267} size={25}>{lang==='en'?'Compare the source with the saved course task.':'对照课件要求，查看已保存的课程任务。'}</Label>
  <Label x={95-mix(0,1040,sourceExit)} y={315} size={20} style={{opacity:1-sourceExit}}>原文 · 第 2 页 · 作业要求</Label>
  <Native source={S.page2} crop={ASSIGNMENT} box={[94-mix(0,1040,sourceExit),345,mix(1030,780,arrive),647]} radius={7}/>
  <Label x={mix(1030,210,focus)} y={315} size={20} style={{opacity:arrive}}>课程任务 · 已保存</Label>
  <Native source={S.task} crop={taskCrop} box={taskBox} radius={17}/>
 </>;
}
function Assignment({t}){return <AssignmentFlow t={t}/>;}
function Task({t}){return <AssignmentFlow t={t}/>;}
function Methods({t}){
 const q=t-10.15,k=p(q,.36,1.2),handoff=p(q,1.32,2.3);
 return <>
  <Type text={'把课件里的方法整理成笔记。'} x={88} y={148} size={81} reveal={p(q,0,.4)}/>
  <Label x={93} y={318} size={22}>原文 · 第 1 页</Label>
  <Native source={S.page1} crop={[1120,898,835,470]} box={lerp([85,370,905,439],[85,432,620,345],handoff)} radius={6}/>
  <div style={{position:'absolute',left:mix(1018,740,handoff),top:532,fontSize:46,color:C.green,transform:`translateX(${mix(-25,0,k)}px)`,opacity:k}}>→</div>
  <Label x={mix(1120,815,handoff)} y={318} size={22} style={{opacity:k}}>课程笔记 · 四步框架</Label>
  <Native source={S.note} crop={[545,975,1480,402]} box={lerp(lerp([1950,380,730,440],[1110,380,730,440],k),[805,367,1030,470],handoff)} radius={14}/>
  <Label x={96} y={885} size={26}>整理「观察、定义、原型、验证」四个步骤。</Label>
 </>;
}
function Save({t}){
 const lang=React.useContext(LANG),q=t-12.65,frame=nativeFrameAt(sequences['note-save-real'],q*1000,{initialHoldMs:550,speed:1});
 const focus=p(q,.6,1.5),result=p(q,1.7,2.55);
 const crop=lerp(lerp([554,1000,1930,573],[554,1103,1930,470],focus),[553,423,1946,1135],result);
 const box=lerp([100,485,1716,452],[170,365,1580,600],result);
 return <>
  <SceneLead q={q} lang={lang} title={lang==='en'?'Add your own observation plan':'补上自己的观察计划'} subtitle={lang==='en'?'Edit the course notes, then save your changes.':'课程笔记可以直接编辑，写完后保存。'} size={82}/>
  <Native source={frame} crop={crop} box={box} radius={16}/>
  <Native source={frame} crop={[1830,421,460,98]} box={[1215,334,600,128]} radius={14} style={{opacity:p(q,.1,.5)*(1-p(q,1.45,1.7))}}/>
  <Label x={110} y={990} size={24} style={{opacity:p(q,2.5,2.85)}}>{lang==='en'?'Saved in the course notes.':'已保存到课程笔记。'}</Label>
 </>;
}
function Close({t}){
 const q=t-15.75,k=p(q,0,.7);
 return <>
  <div style={{position:'absolute',left:78,top:168,width:1764,height:736,background:C.sage,borderRadius:34,clipPath:`inset(0 ${mix(100,0,k)}% 0 0 round 34px)`}}/>
  <Type text={'Mac 上的\nAI 学习与研究助手。'} x={140} y={224} size={115} width={1540} reveal={p(q,.15,.77)}/>
  <div style={{position:'absolute',left:144,top:659,fontSize:43,fontWeight:540,color:C.green,opacity:p(q,.65,1.1)}}>拿一份资料，试试 AI Bro <span style={{marginLeft:42}}>↗</span></div>
  <Label x={148} y={739} size={26} color={C.ink} style={{opacity:p(q,.85,1.3)}}>zihenghe04.github.io/AIBro</Label>
 </>;
}
export function MotionStudy(){
 const t=useCurrentFrame()/STUDY_FPS;
 const Scene=t<2.2?Hook:t<4.5?OpenSource:t<7.3?Assignment:t<10.15?Task:t<12.65?Methods:t<15.75?Save:Close;
 return <AbsoluteFill style={{background:C.paper,color:C.ink,fontFamily:F,WebkitFontSmoothing:'antialiased'}}><Scene t={t}/><Shell/></AbsoluteFill>;
}

export {C,F,p,mix,lerp,S,Native,Type,Label,Rule,Hook,OpenSource,Assignment,Task,Methods,Save,Close};
