import React from 'react';
import {AbsoluteFill,Composition,Sequence,registerRoot} from 'remotion';
import {MotionIntro,INTRO_FRAMES} from './motion-intro.jsx';
import {MotionFilm} from './motion-film.jsx';

export function MotionFull({lang='zh'}){
 return <AbsoluteFill>
  <Sequence durationInFrames={INTRO_FRAMES}><MotionIntro lang={lang}/></Sequence>
  <Sequence from={INTRO_FRAMES} durationInFrames={4368}>
   <Sequence from={-132}><MotionFilm lang={lang} withAudio={false}/></Sequence>
  </Sequence>
 </AbsoluteFill>;
}
const Root=()=> <>{['zh','en'].map(lang=><Composition key={lang} id={'AIBroRefined-'+lang} component={MotionFull} defaultProps={{lang}} durationInFrames={5040} fps={60} width={1920} height={1080}/>)}</>;
registerRoot(Root);
