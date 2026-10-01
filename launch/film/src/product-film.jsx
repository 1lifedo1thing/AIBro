import React from 'react';
import {AbsoluteFill, Sequence, Img, Audio, interpolate, Easing, staticFile, useCurrentFrame} from 'remotion';

// Every shot is a deterministic composition of our actual, fictional-workspace
// App captures. The camera and editorial labels move; the captured UI is intact.
const C={ink:'#243c36',paper:'#f7f8f3',mint:'#e6f3ed',blue:'#edf2f9',accent:'#267c69',muted:'#647c72',line:'#c7dbd0'};
const FONT='"PingFang SC", "Helvetica Neue", Arial, sans-serif';
const curve=Easing.bezier(.2,.85,.18,1);
const tween=(f,a,b,x=0,y=1)=>interpolate(f,[a,b],[x,y],{extrapolateLeft:'clamp',extrapolateRight:'clamp',easing:curve});
const lerp=(a,b,p)=>a+(b-a)*p;
const copy={zh:{
 promise:['让想法，','有下文。'],verbs:['读到的','想到的','要做的'],
 workspace:['你的工作，','自成一处。'],workSub:'资料、对话与成果，在同一个项目里。',
 read:['从原文，','读出新思路。'],readSub:'PDF 原文，始终在手边。',
 write:'把理解，写下来。',writeSub:'可视编辑与 Markdown 源码，自由切换。',
 review:['看得清。','再决定。'],reviewSub:'逐个文件，审阅每一处修改。',
 plan:['下一步，','现在有了位置。'],planSub:'从学习笔记，到任务与日程。',
 choices:['本地优先','模型自选','继续推进'],choiceNote:'远程模型会接收完成请求所需的内容。',
 close:'知识与行动，在一起。',cta:'探索 Mac 预览版',
 evidence:'实际 App 界面 · 虚构演示资料',note:'镜头经动画编排，非实时模型执行',
 pages:['阅读','写作','行动'],
},en:{
 promise:['Give your ideas','a next step.'],verbs:['What you read','What you think','What you do'],
 workspace:['A place for','your project.'],workSub:'Sources, conversations, and outcomes. Together.',
 read:['From the source.','Into your thinking.'],readSub:'Keep the original PDF close.',
 write:'Make the work your own.',writeSub:'Visual editing. Markdown source. Your choice.',
 review:['See the edit.','Make the call.'],reviewSub:'Review every change, file by file.',
 plan:['The next step.','In your day.'],planSub:'From a learning note to tasks and a schedule.',
 choices:['Local first','Your model','Keep going'],choiceNote:'Remote models receive the content needed for your request.',
 close:'Knowledge into action.',cta:'Explore the Mac preview',
 evidence:'Actual App captures · Fictional workspace',note:'Choreographed camera motion. Not live model execution.',
 pages:['READ','WRITE','ACT'],
}};

function Word({children,at=0,size=96,color=C.ink,style={}}){
 const f=useCurrentFrame(), p=tween(f,at,at+19);
 return <div style={{overflow:'hidden',paddingBottom:9,...style}}><div style={{fontSize:size,fontWeight:580,letterSpacing:-size*.043,lineHeight:1.13,color,whiteSpace:'nowrap',transform:`translateY(${(1-p)*109}%)`,opacity:tween(f,at,at+8)}}>{children}</div></div>;
}
function Lines({lines,at=0,size=96,color=C.ink,style={}}){return <div style={style}>{lines.map((x,i)=><Word key={x} at={at+i*5} size={size} color={color}>{x}</Word>)}</div>}
function Small({children,at=24,style={}}){const f=useCurrentFrame();return <div style={{fontSize:27,lineHeight:1.5,color:C.muted,opacity:tween(f,at,at+15),transform:`translateY(${tween(f,at,at+18,10,0)}px)`,...style}}>{children}</div>}
function Mark({size=36}){return <Img src={staticFile('assets/mark.png')} style={{width:size,height:size,borderRadius:size*.22}}/>}
function Brand(){return <div style={{display:'flex',alignItems:'center',gap:13,fontSize:27,fontWeight:640,letterSpacing:-1}}><Mark/>AI Bro</div>}
function Frame({c,bg=C.paper,label,children}){return <AbsoluteFill style={{background:bg,color:C.ink,overflow:'hidden'}}><div style={{position:'absolute',left:72,top:44}}><Brand/></div><div style={{position:'absolute',right:72,top:51,fontSize:16,letterSpacing:2.6,color:C.muted}}>{label}</div>{children}<div style={{position:'absolute',left:74,right:74,bottom:30,display:'flex',justifyContent:'space-between',color:C.muted,fontSize:17,letterSpacing:.2}}><span>{c.evidence}</span><span>AI BRO / MAC</span></div></AbsoluteFill>}

// Clamp both camera axes to keep every panel fully covered, including intermediate
// zoom positions. This avoids exposing a blank strip at the edge of a capture.
function Crop({src,w,h,from={x:0,y:0,w:1},to=from,p=0,style={}}){
 const width=Math.max(w/lerp(from.w,to.w,p),h*2560/1700);
 const height=width*1700/2560;
 const x=Math.max(0,Math.min(lerp(from.x,to.x,p)*width,width-w));
 const y=Math.max(0,Math.min(lerp(from.y,to.y,p)*height,height-h));
 return <div style={{width:w,height:h,position:'relative',overflow:'hidden',...style}}><Img src={staticFile('assets/demo/'+src)} style={{position:'absolute',maxWidth:'none',width,height,left:-x,top:-y}}/></div>;
}
function Panel({src,box,from,to,p=0,style={},radius=24}){return <div style={{position:'absolute',left:box.x,top:box.y,width:box.w,height:box.h,borderRadius:radius,overflow:'hidden',border:'1px solid rgba(64,95,77,.13)',background:'#fff',boxShadow:'0 32px 80px -24px rgba(35,70,57,.21), 0 3px 8px rgba(35,70,57,.05)',...style}}><Crop src={src} w={box.w} h={box.h} from={from} to={to} p={p}/></div>}
function Dash({at=0,x=0,y=0,w=150}){const f=useCurrentFrame();return <div style={{position:'absolute',left:x,top:y,width:w,height:3,background:C.accent,transformOrigin:'left',transform:`scaleX(${tween(f,at,at+20)})`}}/>}

function Intro({c,lang}){
 const f=useCurrentFrame(),settle=tween(f,21,48),leave=tween(f,130,150);
 return <AbsoluteFill style={{background:C.paper,color:C.ink,overflow:'hidden'}}>
  <div style={{position:'absolute',left:128,top:42,width:1664,height:996,border:'1px solid #d7e3da',borderRadius:42,transform:`scale(${tween(f,0,25,.91,1)})`,opacity:tween(f,0,22)}}/>
  <div style={{position:'absolute',left:0,right:0,top:lerp(420,183,settle),display:'flex',justifyContent:'center',alignItems:'center',gap:24,transform:`scale(${lerp(1.35,.72,settle)}) translateY(${-leave*38}px)`,opacity:tween(f,0,10)*(1-leave)}}><div style={{clipPath:`inset(${tween(f,0,20,100,0)}% 0 0 0 round 20px)`,transform:`rotate(${tween(f,0,23,-12,0)}deg)`}}><Mark size={88}/></div><span style={{fontSize:120,fontWeight:640,letterSpacing:-7}}>AI Bro<span style={{color:C.accent}}>.</span></span></div>
  <Lines lines={c.promise} at={36} size={lang==='zh'?148:122} style={{position:'absolute',top:352,left:0,right:0,textAlign:'center',transform:`translateY(${-leave*22}px)`,opacity:1-leave}}/>
  <div style={{position:'absolute',left:320,right:320,top:790,display:'flex',justifyContent:'space-between',alignItems:'center'}}>{c.verbs.map((word,i)=><React.Fragment key={word}><div style={{fontSize:lang==='zh'?29:24,color:C.muted,opacity:tween(f,69+i*9,81+i*9),transform:`translateY(${tween(f,69+i*9,86+i*9,22,0)}px)`}}>{word}</div>{i<2&&<div style={{width:140,height:1,background:C.line,transformOrigin:'left',transform:`scaleX(${tween(f,77+i*9,98+i*9)})`}}/>}</React.Fragment>)}</div>
  <Small at={87} style={{position:'absolute',bottom:96,textAlign:'center',width:'100%',fontSize:18,letterSpacing:3}}>A PERSONAL WORKSPACE FOR WHAT COMES NEXT</Small>
 </AbsoluteFill>;
}
function Workspace({c,lang}){
 const f=useCurrentFrame(),enter=tween(f,0,26),focus=tween(f,86,120),exit=tween(f,186,210);
 return <Frame c={c} label="A PLACE TO BEGIN" bg={C.mint}>
  <Lines lines={c.workspace} at={2} size={lang==='zh'?92:74} style={{position:'absolute',left:96,top:188,zIndex:5}}/>
  <Small at={20} style={{position:'absolute',left:100,top:436,fontSize:24,maxWidth:480}}>{c.workSub}</Small>
  <div style={{position:'absolute',inset:0,perspective:2200}}>
   <Panel src="native-overview.png" box={{x:640,y:165,w:1160,h:770}} from={{x:0,y:0,w:1}} to={{x:.205,y:.095,w:.79}} p={focus} style={{transform:`translateY(${(1-enter)*160-exit*30}px) rotateY(${lerp(-13,0,focus)}deg) rotateX(${lerp(7,0,focus)}deg) rotateZ(${lerp(-2,0,focus)}deg) scale(${lerp(.86,1.04,enter)})`,opacity:enter}}/>
   <Panel src="native-reader.png" box={{x:80,y:600,w:410,h:278}} from={{x:.405,y:.22,w:.38}} style={{transform:`translateX(${tween(f,38,64,-160,0)}px) rotateZ(-6deg)`,opacity:tween(f,38,57)*(1-tween(f,140,159))}}/>
   <Panel src="native-agenda.png" box={{x:330,y:683,w:410,h:216}} from={{x:.55,y:.37,w:.42}} style={{transform:`translateY(${tween(f,51,76,190,0)}px) rotateZ(5deg)`,opacity:tween(f,51,70)*(1-tween(f,146,165))}}/>
  </div>
  <Dash at={29} x={100} y={545} w={118}/>
 </Frame>;
}
function Reader({c,lang}){
 const f=useCurrentFrame(),enter=tween(f,0,24),push=tween(f,78,112),out=tween(f,207,240);
 return <Frame c={c} label="READ / FOLLOW THE SOURCE" bg={C.paper}>
  <div style={{position:'absolute',left:1050,top:132,width:780,height:810,background:C.mint,borderRadius:38,transform:`rotate(${tween(f,0,36,8,3)}deg)`}}/>
  <Lines lines={c.read} at={5} size={lang==='zh'?94:74} style={{position:'absolute',left:96,top:248,opacity:1-out*.8,transform:`translateX(${-out*80}px)`}}/>
  <Small style={{position:'absolute',left:102,top:526,fontSize:25}}>{c.readSub}</Small>
  <Dash at={32} x={102} y={611} w={140}/>
  <div style={{position:'absolute',left:102,top:730,color:C.accent,fontSize:18,letterSpacing:3,opacity:tween(f,45,64)}}>SOURCE → UNDERSTANDING</div>
  <div style={{position:'absolute',inset:0,perspective:2000}}><Panel src="native-reader.png" box={{x:lerp(813,740,push),y:145,w:1050,h:825}} from={{x:.20,y:.12,w:.77}} to={{x:.40,y:.215,w:.397}} p={push} style={{transform:`translateY(${(1-enter)*180}px) rotateY(${lerp(-14,0,push)}deg) rotateZ(${lerp(3,0,push)}deg)`,opacity:enter}}/></div>
 </Frame>;
}
function Writer({c,lang}){
 const f=useCurrentFrame(),shift=tween(f,58,84),exit=tween(f,127,150);
 return <Frame c={c} label="WRITE / MAKE IT YOURS" bg={C.mint}>
  <Word at={0} size={lang==='zh'?100:89} style={{position:'absolute',left:94,top:150}}>{c.write}</Word>
  <Small at={12} style={{position:'absolute',left:100,top:294,fontSize:26}}>{c.writeSub}</Small>
  <div style={{position:'absolute',inset:0,perspective:2300}}><Panel src="native-editor.png" box={{x:98,y:402,w:1724,h:575}} from={{x:.218,y:.233,w:.78}} to={{x:.248,y:.432,w:.70}} p={shift} radius={22} style={{transform:`translateY(${tween(f,0,23,240,0)}px) rotateX(${tween(f,0,30,12,0)}deg) scale(${1+exit*.025})`,opacity:tween(f,0,12)}}/></div>
  <div style={{position:'absolute',right:98,top:324,fontSize:17,letterSpacing:2,color:C.muted,opacity:tween(f,54,68)}}>01 → 02</div>
 </Frame>;
}
function Review({c,lang}){
 const f=useCurrentFrame(),p=tween(f,26,60);
 return <Frame c={c} label="REVIEW / STAY IN CONTROL" bg={C.blue}>
  <Panel src="native-review.png" box={{x:76,y:163,w:1170,h:792}} from={{x:.22,y:.26,w:.72}} to={{x:.35,y:.45,w:.60}} p={p} style={{transform:`translateX(${tween(f,0,19,-90,0)}px)`,clipPath:`inset(0 ${tween(f,0,18,100,0)}% 0 0 round 24px)`}}/>
  <Lines lines={c.review} at={10} size={lang==='zh'?105:72} style={{position:'absolute',left:1320,top:312}}/>
  <Small at={27} style={{position:'absolute',left:1328,top:605,width:470,fontSize:26}}>{c.reviewSub}</Small>
  <Dash at={39} x={1328} y={722} w={112}/>
 </Frame>;
}
function Agenda({c,lang}){
 const f=useCurrentFrame(),wide=tween(f,71,105),settle=tween(f,0,23);
 return <Frame c={c} label="ACT / MAKE ROOM FOR IT" bg={C.paper}>
  <Lines lines={c.plan} at={3} size={lang==='zh'?88:76} style={{position:'absolute',left:96,top:203}}/>
  <Small style={{position:'absolute',left:102,top:450,maxWidth:580,fontSize:25}}>{c.planSub}</Small>
  <div style={{position:'absolute',inset:0,perspective:2200}}><Panel src="native-agenda.png" box={{x:760,y:166,w:1080,h:793}} from={{x:.55,y:.348,w:.18}} to={{x:.23,y:.28,w:.74}} p={wide} style={{transform:`translateY(${(1-settle)*120}px) rotateY(${lerp(-10,0,wide)}deg) rotateZ(${lerp(2,0,wide)}deg)`,opacity:settle}}/></div>
  <Panel src="native-agenda.png" box={{x:102,y:664,w:710,h:202}} from={{x:.23,y:.797,w:.71}} style={{transform:`translateY(${tween(f,110,136,100,0)}px) rotateZ(${tween(f,110,138,-3,0)}deg)`,opacity:tween(f,110,127)}} radius={20}/>
  <Dash at={35} x={102} y={560} w={118}/>
 </Frame>;
}
function Values({c,lang}){
 const f=useCurrentFrame();return <Frame c={c} label="YOUR WORK. YOUR WAY." bg={C.mint}>
  <div style={{position:'absolute',left:110,right:110,top:316,display:'flex'}}>{c.choices.map((x,i)=><div key={x} style={{flex:1,borderLeft:'1px solid '+C.line,paddingLeft:38,transform:`translateY(${tween(f,i*10,i*10+22,75,0)}px)`,opacity:tween(f,i*10,i*10+12)}}><div style={{fontSize:18,color:C.accent,letterSpacing:3,marginBottom:50}}>0{i+1}</div><div style={{fontSize:lang==='zh'?70:62,fontWeight:580,letterSpacing:-3}}>{x}</div><div style={{marginTop:45,width:92,height:3,background:C.accent,transformOrigin:'left',transform:`scaleX(${tween(f,14+i*10,37+i*10)})`}}/></div>)}</div>
  <Small at={32} style={{position:'absolute',left:153,top:746,fontSize:22}}>{c.choiceNote}</Small>
 </Frame>;
}
function Close({c,lang}){
 const f=useCurrentFrame(),p=tween(f,0,23);return <AbsoluteFill style={{background:C.paper,color:C.ink,overflow:'hidden'}}>
  <div style={{position:'absolute',left:280,top:148,width:1360,height:780,border:'1px solid '+C.line,borderRadius:44,transform:`scale(${lerp(.94,1,p)})`}}/>
  <div style={{position:'absolute',left:0,right:0,top:266,display:'flex',alignItems:'center',justifyContent:'center',gap:32,transform:`translateY(${lerp(58,0,p)}px)`,opacity:p}}><Mark size={132}/><div style={{fontSize:180,fontWeight:640,letterSpacing:-10}}>AI Bro<span style={{color:C.accent}}>.</span></div></div>
  <Word at={8} size={lang==='zh'?60:65} style={{position:'absolute',top:526,left:0,right:0,textAlign:'center'}}>{c.close}</Word>
  <Small at={17} style={{position:'absolute',top:667,left:0,right:0,textAlign:'center',fontSize:27,color:C.accent}}>{c.cta} <span style={{paddingLeft:16}}>↗</span></Small>
  <Small at={24} style={{position:'absolute',top:737,left:0,right:0,textAlign:'center',fontSize:22}}>zihenghe04.github.io/AIBro</Small>
  <div style={{position:'absolute',left:0,right:0,bottom:65,textAlign:'center',fontSize:17,color:C.muted}}>{c.note}</div>
 </AbsoluteFill>;
}
export function ProductFilm({lang='zh',withAudio=true}){
 const c=copy[lang]||copy.zh;
 const scenes=[[0,150,Intro],[150,210,Workspace],[360,240,Reader],[600,150,Writer],[750,120,Review],[870,210,Agenda],[1080,90,Values],[1170,90,Close]];
 return <AbsoluteFill style={{background:C.paper,fontFamily:FONT,WebkitFontSmoothing:'antialiased'}}>{withAudio&&<Audio src={staticFile('assets/film/score.wav')} volume={.85}/>} {scenes.map(([start,duration,Component])=><Sequence key={start} from={start} durationInFrames={duration}><Component c={c} lang={lang}/></Sequence>)}</AbsoluteFill>;
}
