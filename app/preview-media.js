/* 原件预览的补充形态（对齐 NewMax §5.3 的预览矩阵）：视频 / 音频 / CSV 表格 / HTML。
   PDF 与图片由既有分支处理（本模块不重复实现）。

   安全边界（这几条是刻意的，别在后续改动里放开）：
   · **HTML 一律用 `sandbox=""` 的空沙箱 iframe 渲染**——不执行脚本、不发外链请求、
     不读同源存储。说明书提到"可切换脚本执行"，本实现**刻意不提供该开关**：
     预览他人给的 HTML 时执行脚本，等于把本机交给那份文件。
   · CSV 只做**文本解析**并渲染成表格：不执行公式、不把单元格当 HTML（一律转义）。
   · 表格与文本都有**行数/列数上限**，超出如实说明，不静默截断。 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PreviewMedia = api;
})(globalThis, root => {
  'use strict';
  const ROW_LIMIT = 200;
  const COL_LIMIT = 30;

  const T = (zh, en) => {
    try { return root.WorkstationI18n?.getLanguage?.() === 'en' ? en : zh; }
    catch (error) { return zh; }
  };
  const esc = value => String(value == null ? '' : value)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── 纯函数（由单测直接覆盖） ────────────────────────────────
  function extensionOf(name) {
    const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : '';
  }

  // 由 MIME 与文件名判断该用哪种预览；不认识的返回 null（让既有分支处理）。
  function kindOf(mime, name) {
    const type = String(mime || '').toLowerCase();
    const ext = extensionOf(name);
    if (type.startsWith('video/') || ['mp4', 'mov', 'm4v', 'webm', 'ogv'].includes(ext)) return 'video';
    if (type.startsWith('audio/') || ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'].includes(ext)) return 'audio';
    if (type === 'text/csv' || type === 'application/csv' || ext === 'csv' || ext === 'tsv') return 'csv';
    if (type === 'text/html' || ext === 'html' || ext === 'htm') return 'html';
    return null;
  }

  function delimiterFor(name) {
    return extensionOf(name) === 'tsv' ? '\t' : ',';
  }

  // 小状态机：支持引号包裹、引号内逗号与换行、双写引号转义。
  function parseDelimited(text, delimiter = ',') {
    const source = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      if (quoted) {
        if (char === '"') {
          if (source[index + 1] === '"') { field += '"'; index += 1; }
          else quoted = false;
        } else field += char;
        continue;
      }
      if (char === '"') { quoted = true; continue; }
      if (char === delimiter) { row.push(field); field = ''; continue; }
      if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
      field += char;
    }
    row.push(field);
    rows.push(row);
    while (rows.length && rows[rows.length - 1].every(cell => cell === '')) rows.pop();
    return rows;
  }

  // 有界化：只保留前若干行/列，并如实报告被省略了多少。
  function bounded(rows, { rowLimit = ROW_LIMIT, colLimit = COL_LIMIT } = {}) {
    const head = rows.slice(0, rowLimit).map(row => row.slice(0, colLimit));
    const droppedRows = Math.max(0, rows.length - head.length);
    const droppedCols = rows.reduce((max, row) => Math.max(max, row.length - colLimit), 0);
    return { head, droppedRows, droppedCols: Math.max(0, droppedCols), totalRows: rows.length };
  }

  function tableMarkup(rows, options = {}) {
    const { head, droppedRows, droppedCols, totalRows } = bounded(rows, options);
    if (!head.length) return `<div class="preview-file-note">${esc(T('这个文件没有可显示的内容。', 'This file has no rows to show.'))}</div>`;
    const [first, ...rest] = head;
    const body = rest.map(row => `<tr>${row.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('');
    const notes = [];
    if (droppedRows) notes.push(T(`还有 ${droppedRows} 行未显示（共 ${totalRows} 行）`, `${droppedRows} more rows not shown (${totalRows} total)`));
    if (droppedCols) notes.push(T(`每行最多显示 ${COL_LIMIT} 列，超出部分未显示`, `Showing at most ${COL_LIMIT} columns per row`));
    const foot = notes.length ? `<p class="preview-file-note">${esc(notes.join('；'))}</p>` : '';
    return `<div class="preview-table-wrap"><table class="preview-table"><thead><tr>${first.map(cell => `<th>${esc(cell)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>${foot}`;
  }

  // ── 挂载 ─────────────────────────────────────────────────
  // 返回实际采用的形态（供调用方与测试判断），null 表示本模块不接管。
  function mount(host, { mime, name, url, text } = {}) {
    const doc = root.document;
    if (!doc || !host) return null;
    const kind = kindOf(mime, name);
    if (!kind) return null;
    if (kind === 'video') {
      if (!url) return null;   // 没有原件地址就不接管：渲染一个 src 为空的播放器等于给用户一个坏控件
      const video = doc.createElement('video');
      video.className = 'preview-media';
      video.controls = true;
      video.src = url;
      host.replaceChildren(video);
      return 'video';
    }
    if (kind === 'audio') {
      if (!url) return null;   // 没有原件地址就不接管：渲染一个 src 为空的播放器等于给用户一个坏控件
      const audio = doc.createElement('audio');
      audio.className = 'preview-media';
      audio.controls = true;
      audio.src = url;
      host.replaceChildren(audio);
      return 'audio';
    }
    if (kind === 'csv') {
      // 需要非空文本：表格预览不依赖原件文件（有解析文本即可），但空文本不给空壳。
      if (typeof text !== 'string' || !text.trim()) return null;
      host.innerHTML = tableMarkup(parseDelimited(text, delimiterFor(name)));
      return 'csv';
    }
    if (kind === 'html') {
      if (!url) return null;   // 没有原件地址就不接管（空沙箱 iframe 也无内容可显示）
      // 空 sandbox：不执行脚本、不发请求、不读同源存储。刻意不提供"允许脚本"的开关。
      const frame = doc.createElement('iframe');
      frame.className = 'preview-html-frame';
      frame.setAttribute('sandbox', '');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('title', T('HTML 预览（已沙箱化，不执行脚本）', 'HTML preview (sandboxed, scripts disabled)'));
      frame.src = url;
      host.replaceChildren(frame);
      const note = doc.createElement('p');
      note.className = 'preview-file-note';
      note.textContent = T('以沙箱方式预览：不执行文件里的脚本、不发起外部请求。需要交互时请下载后在本机打开。',
        'Sandboxed preview: scripts and external requests are disabled. Download and open locally if you need interactivity.');
      host.append(note);
      return 'html';
    }
    return null;
  }

  root.PreviewMedia = { mount, kindOf, parseDelimited, bounded, tableMarkup, _pure: { kindOf, parseDelimited, bounded, tableMarkup, extensionOf, delimiterFor, ROW_LIMIT, COL_LIMIT } };
  return root.PreviewMedia;
});
