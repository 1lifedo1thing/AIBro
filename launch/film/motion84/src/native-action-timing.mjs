// An editorial clock over actual, irregularly sampled native screenshots.
// No tweening, interpolation or generated intermediate product states.
export function nativeFrameAt(sequence,presentationMs,{initialHoldMs=null,speed=1}={}) {
  if(!sequence?.frames?.length)throw new Error('Native action requires actual captured frames.');
  if(!Number.isFinite(speed)||speed<=0)throw new Error('Native action playback speed must be positive.');
  const first=sequence.frames[0],next=sequence.frames[1];
  const originalLead=next?next.capturedMs-first.capturedMs:0;
  const heldLead=initialHoldMs==null?originalLead:Math.min(originalLead,Math.max(0,initialHoldMs));
  const clock=Math.max(0,presentationMs)*speed;
  const captureMs=clock<heldLead?first.capturedMs:first.capturedMs+clock+(originalLead-heldLead);
  let frame=first;
  for(const candidate of sequence.frames){if(candidate.capturedMs>captureMs)break;frame=candidate;}
  return {...frame,fullSrc:frame.src,w:frame.width,h:frame.height};
}
export function nativePresentationDurationMs(sequence,{initialHoldMs=null,speed=1,resultHoldMs=0}={}){
  const first=sequence.frames[0],next=sequence.frames[1],last=sequence.frames.at(-1);
  const originalLead=next?next.capturedMs-first.capturedMs:0;
  const heldLead=initialHoldMs==null?originalLead:Math.min(originalLead,Math.max(0,initialHoldMs));
  return (last.capturedMs-first.capturedMs-originalLead+heldLead)/speed+resultHoldMs;
}
