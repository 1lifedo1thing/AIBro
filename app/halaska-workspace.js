/* Business bindings for Halaska. No example timers, replies or synthetic receipts. */
(function (root) {
  'use strict';
  let ready = false;
  const mounted = new WeakSet();
  function renderProjectStart(host, { emptyProject, noTasks, onStart }) {
    if (!ready || !host || !root.HalaskaUI) return false;
    if (!noTasks) return true;
    const en = root.document.documentElement.lang.startsWith('en');
    const title = emptyProject
      ? (en ? 'Start with your first source' : '从第一份资料开始')
      : (en ? 'Turn sources into a next step' : '把资料变成下一步行动');
    const props = {
      title: { component: 'Heading', props: { level: 2, children: title } },
      description: emptyProject
        ? (en ? 'Add a file, a webpage or an idea. Keep your sources and next steps in one project.' : '添加文件、网页或想法，把资料与下一步行动放在同一个项目。')
        : (en ? 'Continue the project conversation to turn the sources you have into a first task.' : '继续项目对话，根据已有资料整理第一项任务。'),
      action: { component: 'Button', props: {
        id: 'projectFirstInput', variant: 'accent', type: 'button',
        children: en ? 'Continue in this project' : '在项目中开始整理', onClick: onStart,
      } },
    };
    host.classList.add('halaska-project-start');
    if (mounted.has(host)) root.HalaskaUI.update(host, props);
    else {
      // This static fallback has no editor or unsaved state. Its original
      // startup listener is replaced by the real project callback above.
      host.replaceChildren();
      root.HalaskaUI.mount(host, 'EmptyState', props);
      mounted.add(host);
    }
    return true;
  }
  function renderProjectMetrics(host, props) {
    if (!ready || !host || !root.HalaskaUI) return false;
    if (mounted.has(host)) root.HalaskaUI.update(host, props);
    else { host.replaceChildren(); root.HalaskaUI.mount(host, 'ProjectMetrics', props); mounted.add(host); }
    return true;
  }
  root.HalaskaWorkspace = { init() { ready = true; }, renderProjectStart, renderProjectMetrics };
})(window);
