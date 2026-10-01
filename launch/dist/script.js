(() => {
'use strict';
const EN={
  "skip": "Skip to content",
  "nav1": "Workspace",
  "nav2": "How it works",
  "nav3": "Your choices",
  "get": "Get AI Bro",
  "release": "0.8.0 · Mac preview",
  "download": "Download for Mac",
  "tabRead": "Read with context",
  "tabReview": "Refine a document",
  "tabPlan": "Take the next step",
  "expand": "View larger",
  "value1": "Sources stay close to your notes",
  "value2": "Every change is yours to review",
  "value3": "Pick up where you left off",
  "readTitle": "Start where<br>the idea begins.",
  "readDesc": "Keep the original beside the conversation. Follow a citation back to the page, make the idea your own, and leave a trail for the next question.",
  "reviewTitle": "AI helps you draft.<br>You make it yours.",
  "reviewDesc": "See exactly what changes. Review a suggestion, compare the difference, and move between visual editing and Markdown. Keep the result as an editable document.",
  "planTitle": "Give the next idea<br>a place in your day.",
  "planDesc": "Turn the work worth doing into a task or an event. A course has a study plan; a project has a next experiment. Come back knowing where to begin.",
  "possTitle": "For the work you care about.",
  "learnTitle": "Start with one course.",
  "learnDesc": "Course material, chapter notes, and revision plans. Let what you learn today become useful in the next session.",
  "researchTitle": "Leave a trail for your research.",
  "researchDesc": "Papers, methods, experiments, and open questions. Connect the evidence and keep your thinking in Research Wiki.",
  "dailyTitle": "Catch the everyday ideas.",
  "dailyDesc": "Quick notes, personal plans, and the next small step. Give scattered thoughts a place you can come back to.",
  "controlTitle": "Work on your Mac.<br>Choose your own way.",
  "localTitle": "Local first",
  "localText": "Materials, conversations, and notes live on your Mac. When you use a remote model, relevant content goes to the service you choose.",
  "modelTitle": "Your choice of model",
  "modelText": "Connect a compatible API or the official local Codex CLI. Model subscriptions and usage credits are provided separately.",
  "syncTitle": "Sync when you want",
  "syncText": "Push and pull supported workspace content through a self-hosted service. SSH provides the connection, not remote file management.",
  "faqTitle": "Before you begin.",
  "faq1": "Which devices are supported?",
  "faq1A": "The 0.8.0 preview is for Apple Silicon Macs on macOS 14 or later. Python and PDF runtimes are included. This is an ad-hoc signed preview, not Apple-notarized. Read the release instructions before installing.",
  "faq3": "Can I build it or host sync myself?",
  "faq3A": "Yes. AI Bro is open source under AGPL-3.0, with build and self-hosted sync guides. Sync supports personal push and pull, and is not end-to-end encrypted. Model credentials and local directory permissions are not synced.",
  "guide": "Read the guide ↗",
  "downloadTitle": "Make room for<br>your next idea.",
  "downloadDesc": "Bring one source. Start your own workspace.",
  "downloadMeta": "Apple Silicon · macOS 14+ · Open-source preview",
  "footerLine": "Keep the context. Carry the idea forward.",
  "changelog": "Changelog",
  "feedback": "Feedback",
  "filmPlay": "Play the product film",
  "filmFormat": "42 sec · 1080p · Product film",
  "filmChapterIntro": "One idea",
  "filmChapterWorkspace": "One workspace",
  "filmChapterRead": "Read with context",
  "filmChapterWrite": "Make it yours",
  "filmChapterPlan": "Move forward",
  "filmChapterClose": "Your choice",
  "heroStatement": "Turn a conversation into work you can continue.",
  "heroDescription": "Your materials, your thinking, and your next step. One workspace.",
  "watchFilm": "Watch the 42-second film",
  "heroMetaNative": "Local first · Your model · Apple Silicon Mac",
  "explore": "Explore the workspace",
  "workspaceTitle": "Less starting over.<br><span>More picking up where you left off.</span>",
  "workspaceDesc": "Conversations, source material, documents, and tasks.<br>A place for each, in the same project.",
  "overviewCaption": "Actual App interface · Fictional example materials",
  "filmNativeTitle": "An idea.<br><span>All the way to something real.</span>",
  "filmNativeDesc": "Your sources, your thinking, and your next step.<br>Meet a new way of working in 42 seconds.",
  "filmNativeDisclosure": "React + Remotion · Actual App screenshots with fictional data · Not continuous footage or a model-speed demonstration",
  "downloadFilm": "Download product film",
  "storiesTitle": "Every idea.<br><span>A place to carry it forward.</span>",
  "storiesDesc": "A source is more than a one-time attachment.<br>Keep what you understand, and move the work forward.",
  "pauseMotion": "Pause page motion",
  "readHook": "The source stays beside the conversation.",
  "readDetails": "Original PDF pages / Citations / Project sources",
  "readerCaption": "Actual reader interface · Fictional materials",
  "reviewHook": "See exactly what changes.",
  "reviewDetails": "Visual editing / Markdown source / Document review",
  "editorCaption": "Actual document interface · Fictional materials",
  "planHook": "Make a little room for the work worth doing.",
  "planDetails": "Project tasks / Calendar / ICS timetables",
  "agendaCaption": "Actual calendar interface · Fictional events",
  "clipNote": "Choreographed from actual App screenshots",
  "openSource": "Open source. Open to your way of working.",
  "faqNative": "Are these actual App screens?",
  "faqNativeA": "Yes. Screens are captured from an isolated AI Bro workspace with fictional materials. The product film uses React + Remotion to choreograph actual screenshots, camera movement, and animated typography. The chapters below show interface steps. Neither is a model-speed benchmark or unedited continuous recording. The App screenshots are in Chinese in both versions of the film.",
  "buildSource": "Build from source ↗",
  "footerNative": "Actual isolated App interface · Fictional materials throughout · AGPL-3.0"
};
const originals=new Map([...document.querySelectorAll('[data-t]')].map(el=>[el.dataset.t,el.innerHTML]));
let lang=new URLSearchParams(location.search).get('lang')==='en'?'en':'zh';
const reduced=matchMedia('(prefers-reduced-motion:reduce)');
let motionEnabled=!reduced.matches,opener=null,filmState='idle';
const players=new Map(),dialog=document.getElementById('media-dialog'),film=document.getElementById('workflow-film'),filmButton=document.getElementById('film-start');
const filmChapters=[...document.querySelectorAll('[data-film-time]')];
let filmLanguage=null,filmGeneration=0,pendingFilmSeek=null;
const t=(zh,en)=>lang==='en'?en:zh;
const text=key=>lang==='en'?(EN[key]||originals.get(key)):originals.get(key);
function updatePlayers(){players.forEach(state=>state.update());}
function updateMotion(){
  document.documentElement.classList.toggle('motion-off',!motionEnabled);
  const btn=document.getElementById('motion-toggle');
  btn.setAttribute('aria-pressed',String(motionEnabled));
  btn.innerHTML=`<span aria-hidden="true">${motionEnabled?'Ⅱ':'▶'}</span><span>${motionEnabled?t('暂停页面动效','Pause page motion'):t('启用页面动效','Enable page motion')}</span>`;
  updatePlayers();
}
function localize(){
  document.documentElement.lang=lang==='en'?'en':'zh-CN';
  document.title=t('AI Bro — 把一次对话，变成可以继续的工作。','AI Bro — Work you can continue.');
  document.querySelector('meta[name="description"]').content=t('AI Bro 是本地优先的 Mac AI 工作台。连接资料、对话、可编辑文档与日程，让知识积累，工作继续。','A local-first Mac workspace for sources, conversations, editable documents and the next step.');
  document.querySelectorAll('[data-t]').forEach(el=>{const v=text(el.dataset.t);if(v!=null)el.innerHTML=v;});
  const btn=document.getElementById('language');btn.textContent=lang==='en'?'中':'EN';btn.setAttribute('aria-label',lang==='en'?'切换为简体中文':'Switch to English');
  document.querySelector('.site-header nav').setAttribute('aria-label',t('主导航','Main navigation'));
  document.querySelector('.demo-navigation').setAttribute('aria-label',t('浏览工作流程','Browse workflows'));
  document.getElementById('close-media').setAttribute('aria-label',t('关闭','Close'));
  dialog.setAttribute('aria-label',t('放大 App 界面','Enlarged App interface'));
  film.setAttribute('aria-label',t('AI Bro 产品宣传短片','AI Bro product film'));
  document.querySelector('.film-chapters').setAttribute('aria-label',t('产品短片章节','Product film chapters'));
  filmChapters.forEach(button=>button.setAttribute('aria-label',`${t('播放','Play')} ${button.querySelector('.film-chapter-time').textContent} · ${text(button.querySelector('[data-t]').dataset.t)}`));
  setFilmLanguage();
  document.querySelectorAll('[data-image]').forEach(el=>el.setAttribute('aria-label',`${t('放大：','Enlarge: ')}${text(el.dataset.caption)}`));
  document.querySelector('.native-overview img').alt=t('AI Bro 实际 Mac 工作区，使用虚构示例资料','Actual AI Bro Mac workspace with fictional example materials');
  players.forEach(state=>state.updateButton());updateFilmStatus();updateMotion();
  if(dialog.open&&opener){document.getElementById('expanded-image').alt=text(opener.dataset.caption);document.getElementById('dialog-caption').textContent=text(opener.dataset.caption);}
}
const observer=new IntersectionObserver(entries=>{
  for(const entry of entries){const state=players.get(entry.target);if(state){state.visible=entry.isIntersecting&&entry.intersectionRatio>=.08;state.update();}}
},{threshold:[0,.08]});
const preload=new IntersectionObserver(entries=>{
  for(const entry of entries){if(entry.isIntersecting&&motionEnabled){players.get(entry.target)?.load();preload.unobserve(entry.target);}}
},{rootMargin:'240px 0px'});
for(const video of document.querySelectorAll('.chapter-video')){
  const frame=video.closest('.clip-frame'),button=frame.querySelector('.clip-play');
  const state={video,visible:false,manualPause:false,manualPlay:false,pending:false,failed:false,
    load(){if(!video.hasAttribute('src')){video.preload='metadata';video.src=video.dataset.src;}},
    allowed(){return this.visible&&!document.hidden&&!dialog.open&&film.paused&&!this.manualPause&&!this.failed&&(motionEnabled||this.manualPlay);},
    updateButton(){
      const caption=text(frame.querySelector('[data-caption]').dataset.caption);
      video.setAttribute('aria-label',`${caption} · ${t('实际界面截图编排','Choreographed from actual App screenshots')}`);
      button.setAttribute('aria-label',this.failed?t('重新加载演示','Retry loading demonstration'):video.paused?t('播放演示','Play demonstration'):t('暂停演示','Pause demonstration'));
      button.innerHTML=`<span aria-hidden="true">${this.failed?'↺':video.paused?'▶':'Ⅱ'}</span>`;
      frame.classList.toggle('is-playing',!video.paused);
      const note=frame.closest('figure').querySelector('.clip-note');
      note.textContent=this.failed?t('短片暂时无法加载。点击重试，或放大查看实际截图。','The clip could not load. Retry, or enlarge the actual screenshot.'):text('clipNote');
      note.setAttribute('role',this.failed?'status':'note');
    },
    update(){if(this.allowed()){this.load();if(video.paused&&!this.pending){this.pending=true;video.play().then(()=>{if(!this.allowed())video.pause();}).catch(()=>{}).finally(()=>{this.pending=false;this.updateButton();});}}else{video.pause();this.updateButton();}}
  };
  video.muted=true;video.defaultMuted=true;video.loop=true;
  video.addEventListener('play',()=>state.updateButton());video.addEventListener('pause',()=>state.updateButton());
  video.addEventListener('loadedmetadata',()=>{state.failed=false;state.updateButton();if(video.videoWidth&&video.videoHeight)video.style.aspectRatio=`${video.videoWidth}/${video.videoHeight}`;});
  video.addEventListener('error',()=>{
    state.failed=true;state.manualPlay=false;state.updateButton();
  });
  button.addEventListener('click',()=>{
    if(state.failed){state.failed=false;state.manualPause=false;state.manualPlay=true;state.visible=true;video.load();state.update();return;}
    if(video.paused){state.manualPause=false;state.manualPlay=true;state.visible=true;}else{state.manualPause=true;state.manualPlay=false;}
    state.update();
  });
  players.set(video,state);observer.observe(video);preload.observe(video);
}
document.getElementById('motion-toggle').addEventListener('click',()=>{motionEnabled=!motionEnabled;if(!motionEnabled){players.forEach(state=>{state.manualPlay=false;});film.pause();}updateMotion();});
reduced.addEventListener('change',()=>{motionEnabled=!reduced.matches;if(!motionEnabled)players.forEach(state=>{state.manualPlay=false;});updateMotion();});
document.addEventListener('visibilitychange',()=>{if(document.hidden)film.pause();updatePlayers();});
function setFilmLanguage(){
  if(filmLanguage===lang)return;
  filmGeneration++;filmLanguage=lang;film.pause();pendingFilmSeek=null;filmState='idle';
  film.preload='none';film.src=`assets/film/promo-${lang}.mp4`;film.poster=`assets/film/poster-${lang}.jpg`;
  film.load();filmButton.hidden=false;
  const download=document.getElementById('film-download');download.href=film.getAttribute('src');download.download=`AI-Bro-Product-Film-${lang.toUpperCase()}.mp4`;
  updateFilmChapters();
}
function updateFilmChapters(){
  const position=Number.isFinite(film.currentTime)?film.currentTime:0;
  filmChapters.forEach((button,index)=>{
    const start=Number(button.dataset.filmTime),end=Number(filmChapters[index+1]?.dataset.filmTime)||42;
    const active=position>=start&&(position<end||index===filmChapters.length-1);
    if(active)button.setAttribute('aria-current','step');else button.removeAttribute('aria-current');
    button.style.setProperty('--chapter-progress',`${Math.max(0,Math.min(1,(position-start)/(end-start)))*100}%`);
  });
}
function updateFilmStatus(){
  const status=document.getElementById('film-status');
  status.hidden=filmState!=='error'&&filmState!=='gesture';
  status.textContent=filmState==='error'?t('短片暂时无法加载。请点击重新加载；也可查看下方实际 App 界面。','The film could not load. Retry, or explore the actual App screens below.'):filmState==='gesture'?t('请使用播放器的播放按钮。','Use the player controls to start the film.'):'';
  filmButton.querySelector('[data-t]').textContent=filmState==='error'?t('重新加载短片','Retry loading film'):filmState==='ended'?t('再看一次','Watch again'):text('filmPlay');
  if(filmState==='error'||filmState==='ended')filmButton.hidden=false;
}
function playFilm(time){
  const generation=filmGeneration;
  if(typeof time==='number')pendingFilmSeek=time;
  if(filmState==='error')film.load();
  if(pendingFilmSeek!==null&&film.readyState>=1){film.currentTime=pendingFilmSeek;pendingFilmSeek=null;}
  filmState='idle';filmButton.hidden=true;updateFilmStatus();
  film.play().catch(error=>{
    if(generation!==filmGeneration||error.name==='AbortError')return;
    if(filmState!=='error')filmState='gesture';updateFilmStatus();
  });
}
filmButton.addEventListener('click',()=>playFilm(film.ended?0:undefined));
filmChapters.forEach(button=>button.addEventListener('click',()=>{
  film.scrollIntoView({behavior:reduced.matches?'instant':'smooth',block:'center'});
  playFilm(Number(button.dataset.filmTime));
}));
film.addEventListener('play',()=>{filmState='playing';filmButton.hidden=true;updateFilmStatus();updatePlayers();});
film.addEventListener('pause',updatePlayers);
film.addEventListener('timeupdate',updateFilmChapters);
film.addEventListener('ended',()=>{filmState='ended';updateFilmStatus();updateFilmChapters();});
film.addEventListener('loadedmetadata',()=>{
  if(pendingFilmSeek!==null){film.currentTime=Math.min(pendingFilmSeek,Number.isFinite(film.duration)?film.duration:42);pendingFilmSeek=null;}
  if(filmState==='error'){filmState='idle';updateFilmStatus();}
  updateFilmChapters();
});
film.addEventListener('error',()=>{filmState='error';updateFilmStatus();});
new IntersectionObserver(entries=>{if(!entries[0].isIntersecting)film.pause();},{threshold:.02}).observe(film);
for(const trigger of document.querySelectorAll('[data-image]')){
  trigger.addEventListener('click',()=>{
    opener=trigger;const image=document.getElementById('expanded-image');image.src=trigger.dataset.image;image.alt=text(trigger.dataset.caption);
    document.getElementById('dialog-caption').textContent=text(trigger.dataset.caption);film.pause();dialog.showModal();updatePlayers();
  });
}
function closeDialog(){dialog.close();opener?.focus();updatePlayers();}
document.getElementById('close-media').addEventListener('click',closeDialog);
dialog.addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeDialog();}});
document.getElementById('language').addEventListener('click',()=>{lang=lang==='zh'?'en':'zh';const url=new URL(location.href);if(lang==='en')url.searchParams.set('lang','en');else url.searchParams.delete('lang');history.pushState(null,'',url);localize();});
window.addEventListener('popstate',()=>{lang=new URLSearchParams(location.search).get('lang')==='en'?'en':'zh';localize();});
const reveals=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting){entry.target.classList.add('is-revealed');reveals.unobserve(entry.target);}}},{threshold:.06});
if(!reduced.matches){document.querySelectorAll('.section-heading,.native-overview,.story-copy,.story-media,.use-cases article,.control>div,.faq>h2,.faq-list').forEach(el=>{if(el.getBoundingClientRect().top>window.innerHeight){el.classList.add('reveal-in');reveals.observe(el);}});}
const chapterObserver=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting){document.querySelectorAll('.demo-navigation a').forEach(a=>a.classList.toggle('is-current',a.hash===`#${entry.target.id}`));}}},{rootMargin:'-15% 0px -45% 0px',threshold:0});
document.querySelectorAll('.story').forEach(el=>chapterObserver.observe(el));
localize();
})();
