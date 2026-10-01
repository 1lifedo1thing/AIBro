import { safeDocumentUrl } from './visual-policy.mjs';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const IMAGE_ACCEPT = [...IMAGE_TYPES, '.png', '.jpg', '.jpeg', '.gif', '.webp'].join(',');
export function supportedImage(file) {
  return !!file && IMAGE_TYPES.has(String(file.type || '').toLowerCase()) && Number(file.size) > 0;
}
export function durableImage(result, file) {
  const url = typeof result?.url === 'string' ? result.url.trim() : '';
  if (!url || !safeDocumentUrl(url, { image: true })) throw Error('图片未返回可保存的地址，请重试。');
  return { url, alt: String(result.alt || file.name || '图片').replace(/[\r\n\u0000]/g, ' ').slice(0, 500) };
}
export function imageMarkdown(images) {
  return images.map(({ url, alt }) => `![${alt.replace(/[\\[\]]/g, '\\$&')}](<${url.replace(/</g, '%3C').replace(/>/g, '%3E')}>)`).join('\n\n');
}

/** Shared lifetime/ordering contract. Adapters own positions in their real editor
 * state; uploaded addresses never replace a complete host document snapshot. */
export function createImageUploads({ upload, capture, insert, remove, available, settle, report, onBusy }) {
  const pending = new Set();
  let generation = 0, tail = Promise.resolve(), destroyed = false;
  const busy = () => { if (!destroyed) onBusy?.(pending.size); };
  const error = issue => { if (!destroyed) report?.(issue instanceof Error ? issue : Error(String(issue))); };
  function insertFiles(input, position) {
    const files = Array.from(input || []);
    if (!files.length) return Promise.resolve(false);
    if (typeof upload !== 'function') { error(Error('当前文档暂不支持保存本地图片。')); return Promise.resolve(false); }
    if (destroyed || !available()) return Promise.resolve(false);
    if (files.some(file => !supportedImage(file))) {
      error(Error('请选择非空的 PNG、JPEG、GIF 或 WebP 图片；本次没有插入文件。'));
      return Promise.resolve(false);
    }
    let anchor;
    try { anchor = capture(files, position); } catch (issue) { error(issue); return Promise.resolve(false); }
    const epoch = generation;
    let complete;
    const promise = new Promise(resolve => { complete = resolve; });
    const job = { anchor, complete, promise };
    pending.add(job); busy();
    const valid = () => !destroyed && epoch === generation && pending.has(job) && available();
    const finish = value => {
      if (!pending.delete(job)) return;
      remove(anchor); complete(value); busy();
    };
    const run = async () => {
      if (!valid()) { finish(false); return; }
      let okay = true;
      const images = [];
      for (const file of files) {
        if (!valid()) { finish(false); return; }
        try {
          const result = await upload(file);
          if (!valid()) { finish(false); return; }
          images.push(durableImage(result, file));
        } catch (issue) {
          if (!valid()) { finish(false); return; }
          okay = false; error(Error(`${file.name || '图片'}：${issue?.message || String(issue)}`));
        }
      }
      if (images.length && valid() && settle) await settle();
      if (!valid()) { finish(false); return; }
      if (images.length && valid()) {
        try {
          if (insert(anchor, images) === false) {
            okay = false; error(Error('原插入位置已变化，图片没有写入正文。请在需要的位置重新插入。'));
          }
        } catch (issue) { okay = false; error(issue); }
      }
      finish(okay && images.length === files.length);
    };
    // Ordering is stable across quick successive paste/drop/picker gestures.
    tail = tail.then(run, run).catch(issue => { error(issue); finish(false); });
    return promise;
  }
  function cancel() {
    generation++;
    tail = Promise.resolve(); // A canceled transport must not stall new work in this editor.
    for (const job of pending) { remove(job.anchor); job.complete(false); }
    pending.clear(); busy();
  }
  return {
    insertFiles, isBusy: () => pending.size > 0,
    async flush() {
      let okay = true;
      while (pending.size) {
        const results = await Promise.all([...pending].map(job => job.promise));
        if (results.some(result => result === false)) okay = false;
      }
      return !destroyed && okay;
    },
    cancel,
    destroy() { if (destroyed) return; cancel(); destroyed = true; },
  };
}
