import React from 'react';
import {AbsoluteFill,Img,staticFile,useCurrentFrame} from 'remotion';
import actions from '../motion-v3/native-actions.json';
import {nativeFrameAt} from './native-action-timing.mjs';
import {LANG} from './motion-language.jsx';
import {C,F,p,mix,lerp,Native,Label} from './motion-study.jsx';

// Research segment in the 84-second composition. No invented App state or click.
// Persistent-actor / registered-camera principles: motion-video-kit (MIT),
// business-motion-film/references/motion-grammar.md. No upstream code copied.
export const RESEARCH_START_SECONDS=36.1;
export const RESEARCH_SECONDS=18.4;
export const RESEARCH_FPS=60;
const seq=Object.fromEntries(actions.sequences.map(s=>[s.id,s]));
const recall={src:'assets/film/workflow/paper-recall.jpg',w:2560,h:1678};
const L=(lang,zh,en)=>lang==='en'?en:zh;
const BOX=[94,349,1732,661];

// One camera rectangle survives each native capture change. Motion describes
// editorial attention; the captured App's scroll/input state is never synthesized.
export function researchFrame(q){
 if(q<5.8){
  // Land after the complete figures/citation paragraph, above the floating
  // “Back to latest” control in the unmodified native capture.
  const follow=p(q,3.05,5.15);
  return {source:recall,crop:lerp([715,230,1650,630],[715,635,1650,630],follow),box:BOX,phase:'question-answer'};
 }
 if(q<9.4){
  const source=nativeFrameAt(seq['citation-open-real'],(q-5.8)*1000,{initialHoldMs:1000});
  if(q<6.4){
   // The same paragraph is 756 source pixels higher in the later capture.
   // Register its actual pixels before moving the editorial camera. Only the
   // incoming screenshot's body (below native navigation) joins the old frame.
   const shift=mix(0,511,p(q,5.8,6.4));
   return {source,crop:[715,-121+shift,1650,630],box:BOX,phase:'citation-preview',registered:{outgoingCrop:[715,635+shift,1650,630],incomingBodyTop:255}};
  }
  return {source,crop:[715,390,1650,630],box:BOX,phase:'citation-preview'};
 }
 const source=nativeFrameAt(seq['citation-source-real'],(q-9.4)*1000,{initialHoldMs:650});
 // Arrive at the actual PDF first. Only then track down that same page to the
 // paragraph and complete two-row table; all page pixels remain from the capture.
 const toPage=p(q,10.05,10.65),toTable=p(q,12.8,15.7);
 const crop=lerp(lerp([715,390,1650,630],[715,235,1650,630],toPage),[700,895,1690,670],toTable);
 return {source,crop,box:BOX,phase:q<12.8?'open-original':'table'};
}
function ResearchNative({frame}){
 if(!frame.registered)return <Native source={frame.source} crop={frame.crop} box={frame.box} radius={20}/>;
 const [x,y,w,h]=frame.box,scale=Math.min(w/frame.crop[2],h/frame.crop[3]);
 const edge=Math.max(-24,(frame.registered.incomingBodyTop-frame.crop[1])*scale);
 return <>
  <Native source={recall} crop={frame.registered.outgoingCrop} box={frame.box} radius={20}/>
  <div style={{position:'absolute',left:x,top:y,width:w,height:h,borderRadius:20,overflow:'hidden',maskImage:`linear-gradient(to bottom, transparent ${edge-12}px, black ${edge+12}px)`}}>
   <Native source={frame.source} crop={frame.crop} box={[0,0,w,h]} radius={20} shadow={false}/>
  </div>
 </>;
}
export function ResearchScene({q,lang='zh'}){
 const frame=researchFrame(q),sourceMode=q>=10.8;
 const enter=p(q,0,.5),compact=p(q,.9,1.6),headingIn=sourceMode?p(q,10.8,11.15):enter;
 const title=L(lang,sourceMode?'回到原文，核对数字':'找回读过的资料',sourceMode?'Check the figures in the source':'Find a source you read before');
 const subtitle=L(lang,sourceMode?'打开引用页，核对回答中的数据和适用范围。':'描述记得的内容，查回结论和出处。',sourceMode?'Open the cited page. Check the data and its limits.':q<5.8?'Which source said uncertain waits feel longer?':'Describe what you remember. Find the answer and its source.');
 const caption=q<5.8?L(lang,'研究资料查询 · 问题与回答','Find its figures and original page.'):q<9.4?L(lang,'点击引用 → 查看来源预览','Citation → Source preview'):q<12.8?L(lang,'打开原文 → 第 2 页','Open original → Page 2'):L(lang,'4.8 / 7.1 分钟 · 与回答逐项核对','Perceived wait: 4.8 vs 7.1 min · clear vs vague arrival times');
 return <>
  <div style={{position:'absolute',left:94,top:mix(141,131,compact),fontSize:lang==='en'?67:82,fontWeight:570,letterSpacing:-2.5,lineHeight:1.13,width:1740,opacity:headingIn,transform:`translateY(${(1-headingIn)*14}px)`}}>{title}</div>
  <div style={{position:'absolute',left:98,top:234,width:1660,fontSize:27,lineHeight:1.4,color:C.muted,opacity:enter,transform:`translateY(${(1-enter)*10}px)`}}>{subtitle}</div>
  <ResearchNative frame={frame}/>
  <div style={{position:'absolute',left:98,top:304,display:'flex',justifyContent:'space-between',width:1715,fontSize:20,color:C.muted,lineHeight:1.3}}><span>{caption}</span><span>{q>=12.8?L(lang,'合成示例数据，非真实研究结论','Synthetic data, not research evidence'):''}</span></div>
 </>;
}
export function ResearchCandidate({lang='zh'}){
 const q=useCurrentFrame()/RESEARCH_FPS;
 return <LANG.Provider value={lang}><AbsoluteFill style={{background:C.paper,color:C.ink,fontFamily:F,WebkitFontSmoothing:'antialiased'}}>
  <div style={{position:'absolute',left:76,top:40,display:'flex',alignItems:'center',gap:12,fontSize:30,fontWeight:600,letterSpacing:-.8}}><Img src={staticFile('assets/mark.png')} style={{width:36,height:36,borderRadius:9}}/>AI Bro</div>
  <Label x={1340} y={44} size={18}>{L(lang,'城市低碳交通 · 资料查询','RESEARCH & SOURCES')}</Label>
  <ResearchScene q={q} lang={lang}/>
  <div style={{position:'absolute',left:78,right:78,bottom:27,display:'flex',justifyContent:'space-between',fontSize:16,color:C.muted}}><span>{L(lang,'原生 App 画面 · 原创虚构资料 · 多会话剪辑','Native App captures · Fictional materials · Edited across sessions')}</span><span>{L(lang,'开发预览 · 操作与等待经剪辑','Development preview · Actions and waiting condensed')}</span></div>
 </AbsoluteFill></LANG.Provider>;
}
