import React from 'react';
import {interpolate,Easing} from 'remotion';

// Editorial captions, never product chrome. Each scene chooses its own framing.
const eased=(t,a,b)=>interpolate(t,[a,b],[0,1],{easing:Easing.bezier(.22,.8,.18,1),extrapolateLeft:'clamp',extrapolateRight:'clamp'});
export function SceneLead({title,subtitle,q=0,lang='zh',x=90,y=150,width=1720,size=84,subtitleWidth,subtitleSize=27,delay=0,settled=false}){
 const enter=settled?1:eased(q,delay,delay+.4),follow=settled?1:eased(q,delay+.1,delay+.55);
 return <div style={{position:'absolute',left:x,top:y,width,color:'#153c32'}}>
  <div style={{fontSize:size*(lang==='en'?.84:1),fontWeight:570,letterSpacing:-size*.035,lineHeight:1.12,whiteSpace:'pre-line',opacity:enter,transform:`translateY(${(1-enter)*18}px)`}}>{title}</div>
  {subtitle&&<div style={{width:subtitleWidth||width,marginTop:24,fontSize:subtitleSize,lineHeight:1.4,whiteSpace:'pre-line',color:'#55695e',opacity:follow,transform:`translateY(${(1-follow)*12}px)`}}>{subtitle}</div>}
 </div>;
}
