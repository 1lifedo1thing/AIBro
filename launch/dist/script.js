(() => {
'use strict';
// English copy. Chinese is the source in index.html; keys match data-t / data-t-alt / data-t-aria.
const EN={
  skip:'Skip to content',navLabel:'Main navigation',footLabel:'Footer',
  nav1:'What’s new',nav2:'Features',nav3:'Film',nav4:'FAQ',get:'Download',
  pillTag:'New',release:'0.9.5 · Mac preview',
  heroTitle:'Understand your sources.<br><span>Plan what comes next.</span>',
  heroLead:'Ask your lectures and papers. Answers cite the file and page. Select a line to follow up, and note assignments and events in one sentence.',
  downloadDmg:'Download for Mac',seeNew:'See what’s new in 0.9.5',
  disclosure:'Actual App UI (shown in Chinese) · fictional materials · scripted demo answers',
  altOverview:'AI Bro Overview: the sidebar lists conversations, agenda, notes and three projects; the main area shows today’s and upcoming tasks.',
  newTitle:'New in 0.9.5',fullChangelog:'Full changelog',
  new1:'Smoother conversations',new1d:'Messages rise from the composer, new text fades in, and thinking expands while the model works.',
  new2:'Agent timeline',new2d:'Search, reading the source and model thinking appear in order, with returned files shown as pills.',
  new3:'Selection actions',new3d:'Select text in a PDF to explain, translate, annotate or ask AI, with the file name and page attached.',
  new4:'Glass and capsules',new4d:'Buttons, segmented controls and popovers use macOS capsules and glass, with consistent transitions.',
  new5:'A more reliable agent',new5d:'Transient failures retry, malformed tool calls go back to the model once, and unanswered tools are marked “result unknown”.',
  f1Title:'Ask once.<br><span>Watch how it looks.</span>',
  f1Text:'After you ask, AI searches the project’s materials, then reads the original. Each step sits on a timeline: what it searched, which page it read, when it finished.',
  f1a:'Messages rise from the composer',f1b:'Thinking opens while it runs, then folds away',f1c:'Search results appear as file pills',
  ariaLoop1:'Screen recording: a question is sent, AI searches and reads the lecture, then answers',
  cap1:'Screen recording · 27 s · waits not shortened',seeStill:'View still',
  f2Title:'Every point<br><span>leads back to the source.</span>',
  f2Text:'Numbers in an answer map to sources actually read in that turn. Open one to see the file, page and excerpt, then open the PDF to check.',
  f2a:'Sources listed by file and page',f2b:'Excerpt beside the answer',f2c:'“Open original” jumps to the page',
  altCitation:'Beside the answer “Lecture 1 · four review points”, citation 1 is open, showing the PDF name, page 1 and an excerpt.',
  f3Title:'Select a line.<br><span>Keep asking.</span>',
  f3Text:'Conversation and PDF open side by side. Select text for Explain, Translate, Annotate and Ask AI. Ask AI places the line in the composer with its file name and page.',
  f3a:'Reader and conversation in split view',f3b:'Quotes carry file and page',f3c:'Incognito mode never sends the selection',
  ariaLoop2:'Screen recording: a sentence is selected in a PDF, Ask AI is clicked, and the quote lands in the composer',
  cap2:'Screen recording · 11 s',seeResult:'View the quote',
  moreTitle:'Start with an idea.<br><span>End with a next step.</span>',
  t1:'Read while you chat',t1d:'Answer on the left, original on the right. Check a line without switching windows.',
  altReader:'Left: answer with course review points. Right: the PDF “Lecture 1 · From observation to prototype”.',
  t2:'Plan in one sentence',t2d:'“Tomorrow at 3 pm, schedule a 20-minute campus observation.” Review it before saving.',
  altAgenda:'Agenda card in a conversation: 20-minute campus observation, saved 1/1, linked to Interaction Design Methods.',
  t3:'Just as calm in dark',t3d:'Follows the system appearance. Glass popovers and capsule controls keep their depth in dark mode.',
  altDark:'AI Bro Overview in dark appearance.',
  t4:'Your files stay on your Mac. You pick the model.',t4d:'Materials, conversations and notes are stored locally. Connect a compatible API or the local Codex CLI channel; with a remote model, the needed content goes to the service you choose.',
  c1:'Local first',c2:'Your model',c3:'Optional self-hosted sync',c4:'Open source, AGPL-3.0',
  filmTitle:'0.9.5 in about a minute',ariaFilm:'AI Bro 0.9.5 product film',
  filmPending:'The film is on its way. The recordings above are the real thing.',
  filmDisclosure:'Actual App UI · fictional materials · scripted demo answers · edited film. The App interface shown is in Chinese.',
  faqTitle:'Questions',
  q1:'Which devices are supported?',a1:'The 0.9.5 preview is for Apple Silicon Macs on macOS 14 or later, and bundles Python and PDF runtimes. It is ad-hoc signed and not yet notarized by Apple; follow the release notes the first time you open it. This release has no new mobile build.',
  q2:'Is this the actual App?',a2:'Yes. Screenshots and recordings come from AI Bro 0.9.5 in a separate demo workspace with fictional lectures and projects. The model’s answers are scripted locally; the interface, tool steps, citations and PDF reader are real. They do not show actual model speed or answer quality.',
  q3:'Do I need my own model?',a3:'Yes. AI Bro connects to a compatible model API or the official local Codex CLI channel; you provide the subscription and quota. Credentials stay on the Mac and are not synced.',
  q4:'Can I build it or host sync myself?',a4:'Yes. AI Bro is open source under AGPL-3.0, with build and self-hosted sync guides. Sync pushes and pulls between your own devices and is not end-to-end encrypted yet.',guide:'Read the guide ↗',
  ctaTitle:'Bring a lecture.<br>Ask what you want to understand.',ctaText:'Download AI Bro 0.9.5, connect a model and add your materials to a first project.',
  releaseNotes:'Release notes',ctaMeta:'Apple Silicon · macOS 14+ · unnotarized preview · <a href="https://github.com/zihenghe04/AIBro/blob/main/docs/DISTRIBUTION.md">Build from source ↗</a>',
  changelog:'Changelog',feedback:'Feedback',footNote:'All imagery comes from an AI Bro 0.9.5 demo workspace · fictional materials · AGPL-3.0',
  capOverview:'Overview',capTimeline:'Agent timeline',capCitation:'Citation source',capQuote:'Ask AI quote in the composer',capReader:'Split reading view',capDark:'Dark appearance'
};
const ZH_EXTRA={capOverview:'总览',capTimeline:'执行时间线',capCitation:'引用来源',capQuote:'问 AI：引用进入输入框',capReader:'分屏阅读',capDark:'深色外观'};
const params=new URLSearchParams(location.search);
let lang=params.get('lang')==='en'?'en':'zh';
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const root=document.documentElement;
root.classList.add('js');

// Capture the Chinese originals once so switching back restores them exactly.
const originals=new Map();
document.querySelectorAll('[data-t]').forEach(el=>originals.set('t:'+el.dataset.t,el.innerHTML));
document.querySelectorAll('[data-t-alt]').forEach(el=>originals.set('alt:'+el.dataset.tAlt,el.alt));
document.querySelectorAll('[data-t-aria]').forEach(el=>originals.set('aria:'+el.dataset.tAria,el.getAttribute('aria-label')));
const tr=(zh,en)=>lang==='en'?en:zh;
const label=key=>lang==='en'?EN[key]:ZH_EXTRA[key];

// Looping recordings: play only when visible, never automatically under reduced motion.
const loops=[...document.querySelectorAll('video.loop')].map(video=>{
  const frame=video.closest('.loop-frame'),button=frame.querySelector('.loop-toggle');
  const state={video,button,visible:false,userPaused:reduced.matches,failed:false,loaded:false,
    load(){
      if(state.loaded)return;state.loaded=true;
      for(const entry of video.dataset.sources.split(',')){const [src,type]=entry.split('|');const s=document.createElement('source');s.src=src;s.type=type;video.append(s);}
      video.querySelector('source:last-child').addEventListener('error',()=>{state.failed=true;state.sync();});
      video.preload='auto';video.load();
    },
    sync(){
      const run=state.visible&&!state.userPaused&&!state.failed&&!document.hidden&&!dialog.open;
      if(run){state.load();const p=video.play();if(p)p.catch(()=>{});}else video.pause();
      frame.classList.toggle('is-failed',state.failed);
      const paused=!run;
      button.innerHTML=`<span aria-hidden="true">${state.failed?'↺':paused?'▶':'Ⅱ'}</span>`;
      button.setAttribute('aria-label',state.failed?tr('录屏无法加载，点击重试','Recording failed to load. Retry'):paused?tr('播放录屏','Play recording'):tr('暂停录屏','Pause recording'));
    }
  };
  button.addEventListener('click',()=>{
    if(state.failed){state.failed=false;state.loaded=false;video.querySelectorAll('source').forEach(s=>s.remove());state.userPaused=false;}
    else state.userPaused=!state.userPaused;
    state.sync();
  });
  return state;
});
const loopObserver=new IntersectionObserver(entries=>{
  for(const entry of entries){const s=loops.find(l=>l.video===entry.target);if(!s)continue;s.visible=entry.isIntersecting;if(entry.isIntersecting&&!reduced.matches)s.load();s.sync();}
},{threshold:.25,rootMargin:'120px 0px'});
loops.forEach(s=>loopObserver.observe(s.video));
reduced.addEventListener('change',()=>{loops.forEach(s=>{s.userPaused=reduced.matches;s.sync();});});
document.addEventListener('visibilitychange',()=>{loops.forEach(s=>s.sync());if(document.hidden)film.pause();});

// Scroll reveal. Content is visible without JS (the .js class gates the hidden state).
const revealObserver=new IntersectionObserver(entries=>{
  for(const entry of entries)if(entry.isIntersecting){entry.target.classList.add('in');revealObserver.unobserve(entry.target);}
},{rootMargin:'0px 0px -8% 0px'});
document.querySelectorAll('.reveal').forEach(el=>revealObserver.observe(el));

// Product film. Falls back to a still and a status line until the files are published.
const film=document.getElementById('film-video'),fallback=document.getElementById('film-fallback');
let filmLang=null;
function showFilmFallback(on){fallback.hidden=!on;film.hidden=on;}
function setFilmLanguage(){
  if(filmLang===lang)return;filmLang=lang;
  film.pause();film.removeAttribute('src');film.load();showFilmFallback(true);
  const key=lang==='en'?'En':'Zh',src=film.dataset['src'+key],poster=film.dataset['poster'+key],want=lang;
  // Probe once before attaching, so a not-yet-published film shows the still fallback instead of a broken player.
  fetch(src,{method:'HEAD'}).then(r=>{if(!r.ok||want!==lang)return;film.poster=poster;film.src=src;showFilmFallback(false);}).catch(()=>{});
}
film.addEventListener('error',()=>showFilmFallback(true));
film.addEventListener('play',()=>loops.forEach(s=>{if(!s.video.paused){s.video.pause();}}));

// Image zoom dialog with focus return.
const dialog=document.getElementById('zoom-dialog'),dialogImage=document.getElementById('dialog-image'),dialogStatus=document.getElementById('dialog-status');
let opener=null;
document.querySelectorAll('[data-zoom]').forEach(trigger=>trigger.addEventListener('click',()=>{
  opener=trigger;const name=trigger.dataset.zoom;
  dialogStatus.hidden=true;dialogImage.hidden=false;
  dialogImage.onerror=()=>{
    if(!dialogImage.src.endsWith('.png')){dialogImage.src=`assets/v095/${name}-1600.png`;return;}
    dialogImage.hidden=true;dialogStatus.hidden=false;dialogStatus.textContent=tr('图片暂时无法加载，请稍后再试。','The image could not load. Please try again later.');
  };
  dialogImage.src=`assets/v095/${name}-2560.avif`;
  dialogImage.alt=label(trigger.dataset.caption);
  document.getElementById('dialog-caption').textContent=label(trigger.dataset.caption);
  dialog.showModal();loops.forEach(s=>s.sync());
}));
function closeDialog(){dialog.close();}
dialog.addEventListener('close',()=>{opener?.focus();loops.forEach(s=>s.sync());});
document.getElementById('dialog-close').addEventListener('click',closeDialog);
dialog.addEventListener('click',e=>{if(e.target===dialog)closeDialog();});

function localize(){
  root.lang=lang==='en'?'en':'zh-CN';
  document.title=tr('AI Bro — Mac 上的 AI 学习与研究助手','AI Bro — An AI study and research assistant for Mac');
  document.querySelector('meta[name="description"]').content=tr(originals.get('desc')||document.querySelector('meta[name="description"]').content,'Ask your lectures and papers with answers that cite file and page. Select text to follow up and plan tasks in one sentence. Files stay on your Mac; you choose the model.');
  document.querySelectorAll('[data-t]').forEach(el=>{const k=el.dataset.t;el.innerHTML=lang==='en'&&EN[k]!=null?EN[k]:originals.get('t:'+k);});
  document.querySelectorAll('[data-t-alt]').forEach(el=>{const k=el.dataset.tAlt;el.alt=lang==='en'&&EN[k]?EN[k]:originals.get('alt:'+k);});
  document.querySelectorAll('[data-t-aria]').forEach(el=>{const k=el.dataset.tAria;el.setAttribute('aria-label',lang==='en'&&EN[k]?EN[k]:originals.get('aria:'+k));});
  document.querySelectorAll('button[data-zoom]').forEach(el=>el.setAttribute('aria-label',tr('放大：','Enlarge: ')+label(el.dataset.caption)));
  const btn=document.getElementById('language');
  btn.textContent=lang==='en'?'中文':'EN';
  btn.setAttribute('aria-label',lang==='en'?'切换为简体中文':'Switch to English');
  btn.lang=lang==='en'?'zh-CN':'en';
  dialog.setAttribute('aria-label',tr('放大 App 界面','Enlarged App interface'));
  document.getElementById('dialog-close').setAttribute('aria-label',tr('关闭','Close'));
  if(dialog.open&&opener){dialogImage.alt=label(opener.dataset.caption);document.getElementById('dialog-caption').textContent=label(opener.dataset.caption);}
  loops.forEach(s=>s.sync());
  setFilmLanguage();
}
originals.set('desc',document.querySelector('meta[name="description"]').content);
document.getElementById('language').addEventListener('click',()=>{
  lang=lang==='zh'?'en':'zh';
  const url=new URL(location.href);
  if(lang==='en')url.searchParams.set('lang','en');else url.searchParams.delete('lang');
  history.pushState(null,'',url);localize();
});
window.addEventListener('popstate',()=>{lang=new URLSearchParams(location.search).get('lang')==='en'?'en':'zh';localize();});
localize();
})();
