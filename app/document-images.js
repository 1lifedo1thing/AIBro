/* Durable document images share the existing attachment store and sync path.
 * Markdown holds stable references; only the rendered image gets a host URL. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DocumentImages = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, root => {
  'use strict';
  const MAX_BYTES = 16 * 1024 * 1024;
  const MIME = /^image\/(png|jpeg|gif|webp)$/i;
  const active = value => !!value && !['archived', 'archivedAt', 'deleted', 'deletedAt'].some(key => value[key]) && !['archived', 'deleted'].includes(value.status);
  const unique = (items, id) => { const found = (items || []).filter(item => item?.id === id); return found.length === 1 ? found[0] : null; };
  const identity = value => JSON.stringify([value.id, value.projectId || '', value.workspace || '', value.sourceConversationId || '', value.agentRunId || '']);
  let hooks;
  function note(id) {
    const state = hooks?.getState?.();
    const item = unique(state?.notes, id);
    if (!active(item) || item.projectId && !active(unique(state?.projects, item.projectId)) || hooks?.canAccessNote?.(item) === false) throw Error('这篇文档已不可用，图片没有插入。');
    return item;
  }
  async function request(path, body) {
    const response = await root.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || '图片请求失败，请重试。');
    return result;
  }
  async function encodeFile(file) {
    if (!file || !Number.isFinite(file.size) || file.size <= 0) throw Error('请选择非空图片文件。');
    if (file.size > MAX_BYTES) throw Error('单张图片最多 16 MiB；图片未缩小或截断，请选择较小的原图。');
    if (file.type && !MIME.test(file.type)) throw Error('支持 PNG、JPEG、GIF 和 WebP 图片。');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_BYTES || bytes.length !== file.size) throw Error('图片读取不完整，请重新选择。');
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return root.btoa(binary);
  }
  async function uploadNote(noteId, file) {
    if (!hooks?.save) throw Error('图片存储尚未就绪。');
    const before = note(noteId), owner = identity(before);
    if (hooks.canUploadNote?.(before) === false) throw Error('当前私密上下文不保存图片附件；可以继续编辑文字或已有图片链接。');
    const data = await encodeFile(file);
    if (identity(note(noteId)) !== owner || hooks.canUploadNote?.(note(noteId)) === false) throw Error('文档归属已变化，图片没有插入。');
    const result = await request('/__document-images/upload', { noteId, name: file.name || '图片', data });
    if (identity(note(noteId)) !== owner || hooks.canUploadNote?.(note(noteId)) === false) throw Error('文档归属已变化，图片没有插入。');
    if (!/^\/__files\/[A-Za-z0-9_-]+$/.test(result.url || '') || result.url !== '/__files/' + result.id || !MIME.test(result.mimeType || '') || result.importOrigin?.kind !== 'document-image' || result.importOrigin?.noteId !== noteId) throw Error('图片保存回执无效，正文未修改。');
    const state = hooks.getState();
    const duplicates = (state.imports || []).filter(item => item?.id === result.id);
    if (duplicates.length > 1 || duplicates.length === 1 && (!active(duplicates[0]) || duplicates[0].importOrigin?.kind !== 'document-image' || duplicates[0].importOrigin?.noteId !== noteId || duplicates[0].mimeType !== result.mimeType)) throw Error('图片记录已变化，请重新选择图片。');
    const entry = duplicates[0] || { ...result, createdAt: Date.now(), updatedAt: Date.now(), kind: '图片', content: '', parser: 'document-image', folderPath: '文档图片' };
    // A stable binary must also have a durable import before any draft can
    // reference it. Never delete that binary on undo: revisions still use it.
    if (!duplicates.length) (state.imports ||= []).push(entry);
    try {
      if (await hooks.save() === false) throw Error('图片资料记录尚未保存。');
    } catch (error) {
      if (!duplicates.length) {
        const current = hooks.getState();
        current.imports = (current.imports || []).filter(item => item !== entry);
      }
      throw Error(`图片保存失败：${error.message || error}。正文未插入图片，请重试。`);
    }
    if (identity(note(noteId)) !== owner || hooks.canUploadNote?.(note(noteId)) === false || !resolveNote(noteId, result.url)) throw Error('文档或图片已不可用，图片没有插入。');
    return { url: result.url, alt: file.name || result.name || '图片' };
  }
  function resolveNote(noteId, value) {
    try {
      const current = note(noteId), match = /^\/__files\/([A-Za-z0-9_-]+)$/.exec(String(value || ''));
      if (!match) return '';
      const state = hooks.getState(), image = unique(state.imports, match[1]);
      if (!active(image) || !MIME.test(image.mimeType || '') || hooks.canAccessImage?.(image) === false) return '';
      if ((image.projectId || '') !== (current.projectId || '') || (image.workspace || '') !== (current.workspace || '')) return '';
      const own = image.importOrigin?.kind === 'document-image' && image.importOrigin.noteId === noteId;
      const source = (current.sourceAttachmentIds || []).includes(image.id) || current.sourceAttachmentId === image.id;
      if (!own && !source) return '';
      return `/__files/${encodeURIComponent(image.id)}`;
    } catch (_) { return ''; }
  }
  function pickFiles(document = root.document) {
    return new Promise(resolve => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/gif,image/webp,.png,.jpg,.jpeg,.gif,.webp'; input.multiple = true; input.hidden = true;
      let done = false;
      const finish = files => { if (done) return; done = true; input.remove(); resolve(Array.from(files || [])); };
      input.addEventListener('change', () => finish(input.files), { once: true });
      input.addEventListener('cancel', () => finish([]), { once: true });
      document.body.append(input); input.click();
    });
  }
  async function downloadExport(path, payload, filename, canDeliver = () => true) {
    const response = await root.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) { const error = await response.json(); throw Error(error.error || '图片导出失败，未生成不完整文档。'); }
    const blob = await response.blob();
    if (!canDeliver()) throw Error('文档或访问范围已变化，未导出文件，请重新打开后导出。');
    const url = root.URL.createObjectURL(blob), anchor = root.document.createElement('a');
    anchor.href = url; anchor.download = filename; root.document.body.append(anchor); anchor.click(); anchor.remove();
    root.setTimeout(() => root.URL.revokeObjectURL(url), 30000);
    return true;
  }
  // Parse one inline image without admitting raw HTML or touching code spans.
  function inlineImage(value) {
    if (!value.startsWith('![')) return null;
    let cursor = 2, alt = '';
    for (; cursor < value.length; cursor++) {
      if (value[cursor] === '\n') return null;
      if (value[cursor] === '\\' && cursor + 1 < value.length) { alt += value[++cursor]; continue; }
      if (value[cursor] === ']') break;
      alt += value[cursor];
    }
    if (value.slice(cursor, cursor + 2) !== '](') return null;
    cursor += 2; while (/[ \t]/.test(value[cursor] || '\n')) cursor++;
    let url = '', balance = 0;
    if (value[cursor] === '<') {
      const end = value.indexOf('>', ++cursor); if (end < 0) return null;
      url = value.slice(cursor, end); cursor = end + 1;
    } else {
      for (; cursor < value.length; cursor++) {
        const char = value[cursor];
        if (char === '\\' && cursor + 1 < value.length) { url += value[++cursor]; continue; }
        if (/\s/.test(char)) break;
        if (char === '(') balance++;
        if (char === ')') { if (!balance) break; balance--; }
        url += char;
      }
      if (balance) return null;
    }
    while (/[ \t]/.test(value[cursor] || '\n')) cursor++;
    let title = '';
    if (['"', "'"].includes(value[cursor])) {
      const quote = value[cursor++]; let closed = false;
      for (; cursor < value.length; cursor++) { if (value[cursor] === '\\') { title += value[++cursor] || ''; continue; } if (value[cursor] === quote) { cursor++; closed = true; break; } if (value[cursor] === '\n') return null; title += value[cursor]; }
      if (!closed) return null;
      while (/[ \t]/.test(value[cursor] || '\n')) cursor++;
    }
    if (value[cursor] !== ')' || !url || /[\u0000-\u001f\u007f]/.test(url)) return null;
    return { alt: title && /^\d+(?:\.\d+)?$/.test(alt) ? title : alt, title, url, length: cursor + 1 };
  }
  function hasImages(content) {
    // An unmatched backtick is literal Markdown, not a code span. Index exact
    // length closing runs per paragraph before skipping spans; this also keeps
    // many unmatched runs linear instead of rescanning the rest of the text.
    function paragraphHasImage(value) {
      const spans = new Map(), following = new Map();
      const runs = Array.from(value.matchAll(/`+/g));
      for (let i = runs.length - 1; i >= 0; i--) {
        const run = runs[i], size = run[0].length;
        spans.set(run.index, { end: run.index + size, close: following.get(size) });
        following.set(size, run.index + size);
      }
      for (let i = 0; i < value.length; i++) {
        if (value[i] === '\\') { i++; continue; }
        const span = spans.get(i);
        if (span) { i = (span.close ?? span.end) - 1; continue; }
        // Include reference and shortcut forms; the backend resolves their
        // definitions and decides which original bytes belong in the bundle.
        if (value.slice(i, i + 2) === '![') return true;
      }
      return false;
    }
    let fence = null, paragraph = [];
    for (const line of String(content || '').split(/\r?\n/)) {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (marker) {
        if (!fence) {
          if (paragraphHasImage(paragraph.join('\n'))) return true;
          paragraph = []; fence = marker[1]; continue;
        }
        if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) { fence = null; continue; }
      }
      if (fence) continue;
      if (!line.trim()) {
        if (paragraphHasImage(paragraph.join('\n'))) return true;
        paragraph = [];
      } else paragraph.push(line);
    }
    return paragraphHasImage(paragraph.join('\n'));
  }

  return { init(value) { hooks = value; }, MAX_BYTES, encodeFile, request, uploadNote, resolveNote, pickFiles, downloadExport, inlineImage, hasImages };
});
