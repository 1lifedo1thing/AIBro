(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.DocumentReading = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, root => {
  'use strict';
  const mounted = new WeakMap();
  function mount(host, options = {}) {
    mounted.get(host)?.destroy();
    if (!host?.querySelectorAll) return { destroy() {} };
    const doc = host.ownerDocument, resources = [], active = { value: true }, installedCode = new WeakSet();
    const status = doc.createElement('span');
    status.className = 'document-reader-status'; status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite'); host.append(status);
    const report = value => { if (active.value && host.isConnected) status.textContent = value; };
    let linkIntent = 0;
    const reveal = (id, article = host.querySelector('[data-document-markdown]')) => {
      if (!active.value || !article || !host.contains(article)) return false;
      const target = Array.from(article.querySelectorAll('[id]')).find(node => node.id === id);
      if (!target) { report('当前文档中没有找到这个章节。'); return false; }
      if (!target.matches('a[href],button,input,select,textarea,[tabindex],[contenteditable=true]')) {
        target.setAttribute('tabindex', '-1');
        resources.push(() => target.removeAttribute('tabindex'));
      }
      target.scrollIntoView({ block: 'start', behavior: 'auto' });
      target.focus({ preventScroll: true });
      return true;
    };
    const click = event => {
      const link = event.target.closest?.('a[href^="#"],button[data-document-local-path]');
      const article = link?.closest?.('[data-document-markdown]');
      if (!active.value || !article || !host.contains(article)) return;
      event.preventDefault(); event.stopPropagation();
      const intent = ++linkIntent;
      if (link.hasAttribute('data-document-local-path')) {
        if (typeof options.onOpenDocumentLink !== 'function') { report('此文档没有可用的本机文件上下文。'); return; }
        const isCurrent = () => active.value && host.isConnected && host.contains(link) && intent === linkIntent;
        Promise.resolve().then(() => isCurrent() && options.onOpenDocumentLink({ path: link.getAttribute('data-document-local-path'), fragment: link.getAttribute('data-document-fragment') }, { anchor: link, isCurrent }))
          .catch(error => { if (isCurrent()) report(error?.message || '链接暂时无法打开，当前文档仍保留。'); });
        return;
      }
      let id = link.getAttribute('data-document-anchor');
      try { id ||= decodeURIComponent(link.getAttribute('href').slice(1)); } catch (_) { report('章节链接无效，正文仍保留。'); return; }
      reveal(id, article);
    };
    host.addEventListener('click', click);
    const installCode = pre => {
      if (!active.value || !pre.isConnected || !host.contains(pre) || installedCode.has(pre)) return;
      const code = pre.querySelector('code'); if (!code || !root.HalaskaUI?.mount) return;
      const actions = doc.createElement('div'); actions.className = 'document-code-actions';
      const label = doc.createElement('span'); label.className = 'document-code-label';
      label.textContent = code.getAttribute('data-language') || pre.getAttribute('data-language') || '代码';
      const island = doc.createElement('div'); actions.append(label, island); pre.before(actions);
      let control, copying = false;
      const onCopy = async () => {
        if (copying || !active.value || !host.isConnected || !host.contains(code)) return;
        const text = code.textContent;
        copying = true; control.update({ loading: true, children: '正在复制…' });
        try {
          await root.navigator.clipboard.writeText(text);
          if (active.value && host.contains(code) && code.textContent === text) {
            control.update({ loading: false, children: '已复制', 'aria-label': '代码已复制，再次复制' }); report('代码已复制。');
          }
        } catch (_) {
          if (active.value && host.contains(code)) { control.update({ loading: false, children: '重试复制' }); report('无法访问剪贴板，请选中代码后复制。'); }
        } finally {
          copying = false;
          if (active.value && host.contains(code)) {
            control.update({ loading: false, ...(code.textContent !== text ? { children: '复制代码', 'aria-label': '复制代码' } : {}) });
          }
        }
      };
      control = root.HalaskaUI.mount(island, 'Button', { variant: 'ghost', size: 'sm', children: '复制代码', 'aria-label': '复制代码', onClick: onCopy });
      installedCode.add(pre);
      resources.push(() => { control.unmount(); actions.remove(); });
    };
    // Only visible code blocks acquire React controls in a long document.
    const observer = root.IntersectionObserver ? new root.IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) { observer.unobserve(entry.target); installCode(entry.target); }
    }, { rootMargin: '160px' }) : null;
    for (const pre of host.querySelectorAll('[data-document-markdown] pre[data-document-code]')) {
      if (observer) observer.observe(pre); else installCode(pre);
    }
    for (const image of host.querySelectorAll('[data-document-markdown] img.document-managed-image')) {
      let failed = false;
      const fail = () => {
        if (failed || !active.value || !host.contains(image)) return;
        failed = true;
        image.hidden = true;
        const notice = doc.createElement('span'); notice.className = 'document-image-unavailable';
        notice.textContent = `${image.alt || '图片'} · 原件暂时无法读取，引用仍保留。`; image.after(notice);
        report('部分图片暂时无法读取，请检查原件和项目连接。');
        resources.push(() => { image.hidden = false; notice.remove(); });
      };
      image.addEventListener('error', fail, { once: true });
      resources.push(() => image.removeEventListener('error', fail));
      if (image.complete && image.naturalWidth === 0) fail();
    }
    const handle = { reveal, destroy() {
      if (!active.value) return; active.value = false; observer?.disconnect();
      host.removeEventListener('click', click); resources.forEach(dispose => dispose()); status.remove();
      if (mounted.get(host) === handle) mounted.delete(host);
    } };
    mounted.set(host, handle); return handle;
  }
  return { mount };
});
