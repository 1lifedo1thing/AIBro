/* 消息里的媒体渲染（说明书 §3）：连续多张图片合并成画廊、视频/音频内嵌播放。

   边界（刻意的）：
   · **只处理能拿到地址的媒体**：`fileStored` 用 `/__files/{id}`，旧版导入用 `dataUrl`；
     两者都没有的（只留了解析文本）**交回既有按钮列表**——不显示破图、不假装能播放。
   · **不改消息数据**：只在渲染时分类，附件对象本身一个字不动。
   · **非媒体附件不受影响**：文档、网页等仍走既有渲染（调用方拿回 rest 自己处理）。
   · 图片一律带 `alt`，点击走既有的 `data-open-import`（预览原件）。 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MessageMedia = api;
})(globalThis, root => {
  'use strict';

  const esc = value => String(value == null ? '' : value)
    .replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const T = (zh, en) => {
    try { return root?.WorkstationI18n?.getLanguage?.() === 'en' ? en : zh; }
    catch (error) { return zh; }
  };

  const kindOf = item => {
    const mime = String(item?.mimeType || '').toLowerCase();
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return null;
  };

  // 媒体地址：优先原件存储，其次内联 dataUrl。取不到返回 null（调用方退回按钮）。
  function urlFor(item) {
    if (!item) return null;
    if (item.fileStored) return `/__files/${encodeURIComponent(item.id)}`;
    if (typeof item.dataUrl === 'string' && item.dataUrl.startsWith('data:')) return item.dataUrl;
    return null;
  }

  // 分类：连续的可渲染图片聚成一个画廊组；视频/音频各成一块；其余原样交回。
  // 返回 blocks（有序）与 rest（调用方用既有渲染处理）。
  function classify(items) {
    const blocks = [];
    const rest = [];
    let gallery = null;
    const flush = () => { if (gallery) { blocks.push(gallery); gallery = null; } };
    for (const entry of Array.isArray(items) ? items : []) {
      const item = entry?.original || entry;          // 兼容 {id, original, snapshot} 包装
      const kind = kindOf(item);
      const url = urlFor(item);
      if (!kind || !url) { flush(); rest.push(entry); continue; }
      if (kind === 'image') {
        // 相邻图片并入同一画廊（说明书：「连续多张图片自动合并成画廊」）
        if (!gallery) { gallery = { type: 'gallery', items: [] }; }
        gallery.items.push({ entry, item, url });
        continue;
      }
      flush();
      blocks.push({ type: kind, items: [{ entry, item, url }] });
    }
    flush();
    return { blocks, rest };
  }

  function labelOf(item) {
    return item?.name || item?.originalName || T('附件', 'Attachment');
  }

  function galleryMarkup(block) {
    const many = block.items.length > 1;
    const figures = block.items.map(({ item, url }) => {
      const open = item.id ? ` data-open-import="${esc(item.id)}"` : '';
      return `<button type="button" class="message-media-image"${open} title="${esc(T('点击预览原件', 'Open the original'))}"><img loading="lazy" src="${esc(url)}" alt="${esc(labelOf(item))}" /></button>`;
    }).join('');
    return `<div class="message-media-gallery${many ? ' is-multi' : ''}" data-media-count="${block.items.length}">${figures}${many ? `<span class="message-media-count">${esc(T(`${block.items.length} 张`, `${block.items.length} images`))}</span>` : ''}</div>`;
  }

  function playerMarkup(block) {
    const { item, url } = block.items[0];
    const tag = block.type === 'video' ? 'video' : 'audio';
    const open = item.id ? ` data-open-import="${esc(item.id)}"` : '';
    const media = `<${tag} class="preview-media${tag === 'video' ? '-video' : '-audio'}" controls preload="metadata" src="${esc(url)}"></${tag}>`;
    return `<div class="message-media-player"><div class="message-media-caption"><span class="icon-slot" data-icon="file"></span><b data-user-content>${esc(labelOf(item))}</b><button type="button" class="text-action"${open}>${esc(T('预览原件', 'Open original'))}</button></div>${media}</div>`;
  }

  // 主入口：返回 { markup, rest }。markup 为空串表示没有可渲染的媒体。
  function render(items) {
    const { blocks, rest } = classify(items);
    const markup = blocks.map(block => block.type === 'gallery' ? galleryMarkup(block) : playerMarkup(block)).join('');
    return { markup, rest, blocks };
  }

  root.MessageMedia = { render, classify, urlFor, kindOf, _pure: { classify, urlFor, kindOf, galleryMarkup, playerMarkup } };
  return root.MessageMedia;
});
