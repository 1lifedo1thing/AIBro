(function (root) {
  'use strict';
  let pending;
  const available = () => !!(root.DocumentSourceEditor?.mount && root.DocumentVisualEditor?.mount);
  function ensure() {
    if (available() && root.document.getElementById('document-editors-style')?.sheet) return Promise.resolve(true);
    if (pending) return pending;
    pending = new Promise((resolve, reject) => {
      const doc = root.document;
      let style = doc.getElementById('document-editors-style');
      let script = doc.getElementById('document-editors-script');
      const fail = () => {
        script?.remove(); style?.remove(); pending = null;
        reject(new Error('文档编辑器未能加载，请重试。当前正文和草稿仍保留。'));
      };
      const styleReady = new Promise((done, failed) => {
        if (style?.sheet) { done(); return; }
        style ||= doc.createElement('link'); style.id = 'document-editors-style';
        style.rel = 'stylesheet'; style.href = 'document-editors.css';
        style.onload = done; style.onerror = failed;
        if (!style.parentNode) doc.head.append(style);
      });
      const scriptReady = new Promise((done, failed) => {
        if (available()) { done(); return; }
        script ||= doc.createElement('script'); script.id = 'document-editors-script';
        script.src = 'document-editors-bundle.js'; script.async = true;
        script.onload = () => available() ? done() : failed(); script.onerror = failed;
        if (!script.parentNode) doc.head.append(script);
      });
      Promise.all([styleReady, scriptReady]).then(() => resolve(true), fail);
    });
    return pending;
  }
  root.DocumentEditors = Object.freeze({ ensure, available });
})(typeof globalThis !== 'undefined' ? globalThis : this);
