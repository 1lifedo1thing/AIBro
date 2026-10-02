// Remove only non-action reading holds from the 82-second editorial clock.
// Native action samples keep their timing; this does not speed up App operations.
export const HOLD_CUTS_SECONDS=[
  [9.6,10.15],[16.2,16.75],[23.7,24.5],
  [30.8,32.3],[35.8,36],[38.1,38.5],
  [42.65,43.15],[55.8,56.6],
  [63.85,64.65],[70.8,71.3],[81.4,81.8],
];
export function editorialSourceFrame(frame,fps=60){
  let source=frame;
  for(const [start,end]of HOLD_CUTS_SECONDS){
    const a=Math.round(start*fps),b=Math.round(end*fps);
    if(source>=a)source+=b-a;else break;
  }
  return source;
}
