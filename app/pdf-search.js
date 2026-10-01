/* Local, demand-driven PDF find. One page request at a time; no document upload. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.PDFSearch=api;})(globalThis,function(root){
 'use strict';
 function create(options={}){
  const fetch=options.fetch||root.fetch.bind(root),later=options.setTimeout||root.setTimeout,clear=options.clearTimeout||root.clearTimeout;
  const limit=options.limit||500;
  let state=initial(),epoch=0,request=null,timer=null,destroyed=false;
  function initial(){return {open:false,query:'',phase:'idle',matches:[],active:-1,scanned:0,total:0,incomplete:0,capped:false,error:''};}
  const snapshot=()=>({...state,matches:state.matches.slice()});
  function valid(){if(destroyed)return false;if(options.onValid?.()===false){destroy();return false;}return true;}
  function emit(){if(valid())options.onUpdate?.(snapshot());}
  function abort(){epoch++;request?.abort();request=null;if(timer!==null)clear(timer);timer=null;}
  function open(){if(!valid())return false;state.open=true;emit();return true;}
  function close(){if(!valid())return;abort();state=initial();emit();}
  function destroy(){if(destroyed)return;destroyed=true;abort();state=initial();}
  function query(value){if(!valid())return;abort();state={...initial(),open:true,query:String(value)};
   if(!state.query.trim()){emit();return;}
   if(Array.from(state.query).length>256){state.phase='invalid';emit();return;}
   state.phase='waiting';emit();timer=later(()=>{timer=null;run();},320);
  }
  function select(index){if(!valid()||!state.matches.length)return false;state.active=(index+state.matches.length)%state.matches.length;emit();options.onMatch?.(state.matches[state.active]);return true;}
  function move(delta=1){if(state.phase==='waiting')return run();return select(state.active+delta);}
  function stop(){if(!valid())return;abort();if(['scanning','waiting'].includes(state.phase))state.phase='stopped';emit();}
  async function run(){
   if(!valid()||!state.query.trim()||Array.from(state.query).length>256)return;
   abort();const current=epoch,total=Number(options.getPageCount?.());if(!Number.isSafeInteger(total)||total<1)return;
   const first=Math.min(total,Math.max(1,Number(options.getPage?.())||1));
   state={...initial(),open:true,query:state.query,phase:'scanning',total};emit();
   for(let offset=0;offset<total;offset++){
    if(!valid()||epoch!==current)return;
    const page=(first-1+offset)%total+1;request=new AbortController();const signal=request.signal;
    try{
     const response=await fetch(`${options.base}/preview-search?page=${page}&q=${encodeURIComponent(state.query)}`,{signal});
     const data=await response.json();if(signal.aborted||!valid()||epoch!==current)return;
     if(!response.ok)throw Error(data.error||`PDF search failed (${response.status})`);
     if(data.page!==page||data.pageCount!==total||!Number.isFinite(data.width)||!Number.isFinite(data.height)||data.width<=0||data.height<=0||!Array.isArray(data.matches)||data.matches.length>200)throw Error('Invalid PDF search response');
     const hits=data.matches.map((hit,index)=>{
      if(!Array.isArray(hit.rects)||!hit.rects.length||hit.rects.length>256||!hit.rects.every(rect=>['x','y','width','height','angle'].every(key=>Number.isFinite(rect[key]))&&rect.width>0&&rect.height>0&&[0,90,180,270].includes(rect.angle)))throw Error('Invalid PDF search geometry');
      return {key:`${page}:${index}`,page,width:data.width,height:data.height,rects:hit.rects};
     });
     const room=limit-state.matches.length;state.matches.push(...hits.slice(0,room));state.scanned++;
     if(data.partial||data.truncated||data.unsearchable)state.incomplete++;
     if(hits.length>room||(state.matches.length>=limit&&state.scanned<total)){state.capped=true;state.phase='done';}
     const firstHit=state.active<0&&state.matches.length>0;if(firstHit)state.active=0;
     emit();if(firstHit)options.onMatch?.(state.matches[0]);
     if(state.capped)break;
    }catch(error){if(signal.aborted||!valid()||epoch!==current)return;state.phase='error';state.error=String(error.message||error);emit();return;}
   }
   if(valid()&&epoch===current){request=null;state.phase='done';emit();}
  }
  return {open,close,query,run,move,stop,destroy,snapshot};
 }
 return {create};
});
