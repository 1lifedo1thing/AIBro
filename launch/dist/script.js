'use strict';

// Both languages are local. The download path does not depend on a release API,
// a feature-data request, or JavaScript being available.
const EN = {
  skip: 'Skip to content',
  navLabel: 'Main navigation',
  navWorkspace: 'How it works',
  navScenarios: 'Your work',
  navControl: 'Data & models',
  navDownload: 'Get AI Bro <span aria-hidden="true">↗</span>',
  heroEyebrow: 'A personal workspace for your Mac',
  heroTitle1: 'From what you read.',
  heroTitle2: 'To what you do next.',
  heroDescription: 'Bring sources, conversations, documents and plans together. Think with AI, make your own decisions, and keep work you can edit, verify and build on.',
  downloadAction: 'Get the Mac preview <span aria-hidden="true">↗</span>',
  sourceAction: 'View source <span aria-hidden="true">↗</span>',
  heroMeta: 'Local-first · Your choice of model · Open source',
  mapHeading: 'The context around your work',
  mapSource: 'The material you bring',
  mapLinks: 'Links & ideas',
  mapWork: 'Read. Discuss. Revise.',
  mapWorkText: 'Keep the source, and your own thinking.',
  mapDocument: 'A document you can keep editing',
  mapDocumentDetail: 'Notes / Research / Project plans',
  mapAction: 'A clear next step',
  mapActionDetail: 'Tasks / Events / Follow-up questions',
  mapCaption: 'Workflow diagram, not an app screenshot',
  purpose: 'Made for work that builds over time.',
  purposeLearn: 'Coursework',
  purposeResearch: 'Research',
  purposeDaily: 'Personal projects',
  workflowEyebrow: '01 / Keep the work connected',
  workflowTitle: 'The chat ends.<br>The work carries on.',
  workflowIntro: 'Start with source material, make sense of it, and decide what comes next. Keep it in a project, with a place to return to.',
  viewArchive: 'Watch an early recording <span aria-hidden="true">↗</span>',
  step1Title: 'Give the work a home',
  step1Text: 'Create a project for a course, a research question or a personal plan. Keep its conversations, sources, outputs and tasks together.',
  step2Title: 'Bring a source. Ask the next question.',
  step2Text: 'Add PDFs, documents and links. Move between reading and conversation, follow citations back to the source, and keep asking.',
  step3Title: 'Make the answer your own',
  step3Text: 'Open a note and keep editing in preview or source mode. Inspect suggested AI changes, compare the differences, then choose what to accept.',
  step4Title: 'Keep the result. Plan the next step.',
  step4Text: 'Save your work to a project, break it into tasks and put it on the schedule. Return to the materials, plans and discussions you already built.',
  scenariosEyebrow: '02 / Bring it into your day',
  scenariosTitle: 'Different work.<br>A familiar way through.',
  scenariosIntro: 'Start with a document, a thought or something you need to do. Keep the context without starting over in another tool.',
  learnTitle: 'Connect what you learn.',
  learnText: 'Organize course materials, chapter notes and revision tasks around each class. Read the original, write your own understanding and follow up where you need help.',
  learnTrail: 'Course sources <span>→</span> Your notes <span>→</span> Revision',
  researchTitle: 'Build on what you read.',
  researchText: 'Keep methods, experiments and open questions alongside the papers. Connect notes and sources in a Research Wiki, with evidence and your own interpretation.',
  researchTrail: 'Sources <span>→</span> Research notes <span>→</span> Questions',
  dailyTitle: 'Give ideas somewhere to go.',
  dailyText: 'Capture a thought with its links and attachments. Turn the ideas worth pursuing into projects, tasks and events—one manageable step at a time.',
  dailyTrail: 'Capture <span>→</span> Project tasks <span>→</span> A plan',
  essentialsEyebrow: '03 / The everyday essentials',
  essentialsTitle: 'Read it. Revise it.<br>Find it again.',
  essentialsIntro: 'Conversation is the starting point. Sources, documents, activity and schedules are work you can open and continue.',
  readTitle: 'Room for the source',
  readText: 'Open PDFs and documents in a dedicated reader. Follow sources, resize the workspace and return to the project with context.',
  editTitle: 'Changes you can inspect',
  editText: 'Markdown preview and source, file differences and review help distinguish a suggestion from the content you have saved.',
  historyTitle: 'A trail back to the work',
  historyText: 'Revisit goals, activity and results in execution history. Follow source links and recover supported items from the trash.',
  agendaTitle: 'Give the plan a time',
  agendaText: 'See tasks and events, import an ICS timetable, and edit times, recurrence and reminders. Review AI-proposed events before saving.',
  controlEyebrow: '04 / Keep your choices',
  controlTitle: 'Your work.<br>On your terms.',
  controlIntro: 'Choose a model, decide what joins the conversation, and connect your own sync server when you need one.',
  modelsTitle: 'Change models. Keep your project.',
  modelsText: 'Connect a compatible custom API or configure the local Codex connection, then choose a model per chat. Capabilities depend on the provider, model and local setup.',
  localTitle: 'Your workspace starts on your Mac',
  localText: 'When you use a remote model, the content needed for that request is sent to your chosen provider. Local-first does not mean all AI inference runs on your device.',
  syncTitle: 'Connect a server when you need sync',
  syncText: 'A self-hosted service pushes and pulls supported workspace content; SSH can provide the connection. Sync is not remote file management. Model credentials and local folder permissions stay on the device.',
  syncLink: 'Read the sync guide <span aria-hidden="true">↗</span>',
  archiveEyebrow: 'From an earlier version',
  archiveTitle: 'See a real operation.',
  archiveDescription: 'Recorded September 15, 2026 · Example workspace · Earlier interface',
  archiveNote: 'This is a separate recording of task editing in the English app. The Chinese page has a two-minute product tour. These edited recordings are not model-speed benchmarks or acceptance tests of the current version.',
  filmLabel: 'Early AI Bro recording in English',
  videoFallback: 'Your browser cannot play this video. Use the download link below.',
  archiveCaption: 'Earlier interface · Actual screen recording',
  filmDownload: 'Download recording <span aria-hidden="true">↓</span>',
  helpEyebrow: 'Before you start',
  helpTitle: 'A few things<br>you might want to know.',
  faq1Question: 'Which devices can I use?',
  faq1Answer: 'Current development focuses on the Mac app. Check GitHub Releases for the available packages, system requirements and installation notes. Preview builds may not be notarized by Apple.',
  faq2Question: 'Do I need to connect a model?',
  faq2Answer: 'Yes. AI Bro is a workspace; it does not include a model subscription or API credits. Bring your own compatible API setup. The Codex account connection also requires installing and configuring the official CLI as described in the guide.',
  faq3Question: 'What about the earlier iOS companion?',
  faq3Answer: 'Installation instructions for the existing iOS companion remain in the repository. Development currently focuses on Mac. Features and versions differ by platform; consult the release notes.',
  iosLink: 'Read the iOS installation guide <span aria-hidden="true">↗</span>',
  faq4Question: 'Is this a team collaboration tool?',
  faq4Answer: 'AI Bro currently focuses on personal work. Self-hosted sync pushes and pulls data between your own devices. It does not provide real-time multiplayer collaboration or end-to-end encryption.',
  downloadEyebrow: 'Start with one piece of work',
  downloadTitle: 'Bring your materials.<br>Take the next step.',
  downloadText: 'Download the Mac preview or build from source. Releases list the version, system requirements and known issues.',
  buildAction: 'Build from source <span aria-hidden="true">↗</span>',
  changelogAction: 'Read the changelog <span aria-hidden="true">↗</span>',
  footerDescription: 'From sources to next steps.',
  footerNav: 'Project and support',
  feedbackAction: 'Report an issue <span aria-hidden="true">↗</span>',
  footerNote: 'A personal AI workspace in active development. Available features depend on the version you download.'
};

const localizedText = [...document.querySelectorAll('[data-t]')].map(element => ({ element, key: element.dataset.t, original: element.innerHTML }));
const localizedLabels = [...document.querySelectorAll('[data-label]')].map(element => ({ element, key: element.dataset.label, original: element.getAttribute('aria-label') }));
const languageButton = document.getElementById('language');
const recording = document.getElementById('product-film');
const recordingDetails = document.getElementById('recording-details');
const recordingDownload = document.getElementById('film-download');
const recordingStatus = document.createElement('p');
recordingStatus.hidden = true;
recordingStatus.setAttribute('role', 'status');
recording.after(recordingStatus);
let language = 'zh';

function languageFromURL() {
  return new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh';
}

function ensureRecording() {
  if (recordingDetails.open && recording.getAttribute('src') !== recordingDownload.getAttribute('href')) {
    recording.src = recordingDownload.getAttribute('href');
    recording.load();
  }
}

function renderLanguage() {
  language = languageFromURL();
  const english = language === 'en';
  document.documentElement.lang = english ? 'en' : 'zh-CN';
  document.title = english ? 'AI Bro — From sources to next steps' : 'AI Bro — 从资料，到下一步';
  const description = english
    ? 'A personal AI workspace for learning, research and everyday projects on Mac. Connect sources, conversations, editable documents and plans.'
    : 'AI Bro 是面向学习、科研与日常工作的 Mac AI 工作台。连接资料、对话、可编辑文档与日程，让工作可以接着继续。';
  document.querySelector('meta[name="description"]').content = description;
  document.querySelector('meta[property="og:title"]').content = document.title;
  document.querySelector('meta[property="og:description"]').content = description;
  for (const { element, key, original } of localizedText) element.innerHTML = english ? EN[key] : original;
  for (const { element, key, original } of localizedLabels) element.setAttribute('aria-label', english ? EN[key] : original);
  languageButton.textContent = english ? '中文' : 'EN';
  languageButton.setAttribute('aria-label', english ? '切换至中文' : 'Switch to English');
  languageButton.setAttribute('lang', english ? 'zh-CN' : 'en');
  languageButton.hidden = false;

  // No autoplay or offscreen players. Changing language also changes the real
  // recording, so the English page never substitutes footage of Chinese UI.
  recording.pause();
  recording.removeAttribute('src');
  recording.poster = `assets/recordings/tour-${language}.jpg`;
  recording.width = english ? 1536 : 1532;
  recording.height = english ? 1016 : 1080;
  recordingDownload.href = `assets/recordings/tour-${language}.mp4`;
  recordingStatus.hidden = true;
  recording.load();
  ensureRecording();
}

function revealAnchor(hash = location.hash) {
  let id;
  try { id = decodeURIComponent(hash.slice(1)); } catch { return; }
  if (!id) return;
  const target = document.getElementById(id);
  if (!target) return;
  const enclosingDetails = target.closest('details');
  if (enclosingDetails) enclosingDetails.open = true;
  if (id === 'film') recordingDetails.open = true;
  if (enclosingDetails || id === 'film') {
    target.scrollIntoView({ block: 'start', behavior: 'auto' });
  }
}

languageButton.addEventListener('click', () => {
  const url = new URL(location.href);
  if (language === 'zh') url.searchParams.set('lang', 'en');
  else url.searchParams.delete('lang');
  history.pushState(null, '', url);
  renderLanguage();
});
window.addEventListener('popstate', () => { renderLanguage(); revealAnchor(); });
window.addEventListener('hashchange', () => revealAnchor());
document.querySelectorAll('a[href^="#"]').forEach(link => {
  link.addEventListener('click', () => revealAnchor(link.getAttribute('href')));
});
recordingDetails.addEventListener('toggle', () => {
  if (recordingDetails.open) ensureRecording();
  else recording.pause();
});
recording.addEventListener('error', () => {
  recordingStatus.textContent = language === 'en'
    ? 'This recording could not load. You can download it using the link below.'
    : '录屏暂时无法加载，可以使用下方链接下载后观看。';
  recordingStatus.hidden = false;
});
document.addEventListener('visibilitychange', () => { if (document.hidden) recording.pause(); });

renderLanguage();
revealAnchor();
