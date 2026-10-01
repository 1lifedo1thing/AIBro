'use strict';
/* 消息媒体（§3）：连续图片合并成画廊、视频/音频内嵌、拿不到地址的不假装能渲染。 */
const test = require('node:test');
const assert = require('node:assert/strict');

const MessageMedia = require('../app/message-media.js');

const image = (id, extra = {}) => ({ id, original: { id, name: `${id}.png`, mimeType: 'image/png', fileStored: true, ...extra } });
const video = (id, extra = {}) => ({ id, original: { id, name: `${id}.mp4`, mimeType: 'video/mp4', fileStored: true, ...extra } });
const doc = (id) => ({ id, original: { id, name: `${id}.pdf`, mimeType: 'application/pdf', fileStored: true } });

test('相邻图片合并成一个画廊；被非图片打断则分成两组', () => {
  const continuous = MessageMedia.classify([image('a'), image('b'), image('c')]);
  assert.equal(continuous.blocks.length, 1, '连续三张图应是一组');
  assert.equal(continuous.blocks[0].type, 'gallery');
  assert.equal(continuous.blocks[0].items.length, 3);
  assert.equal(continuous.rest.length, 0);

  const broken = MessageMedia.classify([image('a'), doc('x'), image('b')]);
  assert.equal(broken.blocks.length, 2, '被文档打断应分成两组画廊');
  assert.equal(broken.blocks[0].items.length, 1);
  assert.equal(broken.blocks[1].items.length, 1);
  assert.equal(broken.rest.length, 1, '文档交回既有渲染');
});

test('视频与音频各自成块（不与画廊合并）', () => {
  const mixed = MessageMedia.classify([image('a'), video('v'), image('b')]);
  assert.deepEqual(mixed.blocks.map(block => block.type), ['gallery', 'video', 'gallery']);
  const audio = MessageMedia.classify([{ id: 'au', original: { id: 'au', mimeType: 'audio/mpeg', fileStored: true, name: 'r.mp3' } }]);
  assert.equal(audio.blocks[0].type, 'audio');
});

test('拿不到地址的媒体进 rest（不显示破图、不假装能播放）', () => {
  // 旧版导入：只有解析文本，既没有 fileStored 也没有 dataUrl
  const legacy = { id: 'old', original: { id: 'old', name: '旧图.png', mimeType: 'image/png', fileStored: false, dataUrl: null } };
  const result = MessageMedia.classify([legacy, image('ok')]);
  assert.equal(result.rest.length, 1, '无地址的图片交回既有按钮');
  assert.equal(result.blocks[0].items.length, 1, '有地址的那张仍进画廊');
  // 原件已删除：包装对象里没有 original
  const gone = MessageMedia.classify([{ id: 'gone', original: null, snapshot: { id: 'gone', name: 'x.png' } }]);
  assert.equal(gone.blocks.length, 0);
  assert.equal(gone.rest.length, 1);
});

test('urlFor：原件存储在 /__files、旧版用 dataUrl、都没有返回 null', () => {
  assert.equal(MessageMedia.urlFor({ id: 'a b', fileStored: true }), '/__files/a%20b', 'id 需要转义');
  assert.equal(MessageMedia.urlFor({ id: 'c', dataUrl: 'data:image/png;base64,AAA' }), 'data:image/png;base64,AAA');
  assert.equal(MessageMedia.urlFor({ id: 'd' }), null);
  assert.equal(MessageMedia.urlFor(null), null);
  // 非 data: 的字符串不算地址
  assert.equal(MessageMedia.urlFor({ id: 'e', dataUrl: 'javascript:alert(1)' }), null);
});

test('画廊：多图带张数角标、单图不带；点击走既有预览入口', () => {
  const multi = MessageMedia.render([image('a'), image('b')]).markup;
  assert.match(multi, /message-media-gallery is-multi/);
  assert.match(multi, /message-media-count[^>]*>2 张</, '多图应显示张数');
  assert.match(multi, /data-open-import="a"/, '点击应打开原件预览');
  assert.match(multi, /<img loading="lazy"/, '应懒加载');
  const single = MessageMedia.render([image('a')]).markup;
  assert.doesNotMatch(single, /is-multi/);
  assert.doesNotMatch(single, /message-media-count/, '单图不显示张数');
});

test('播放器：video/audio 各用对应标签、带原生控件与文件名', () => {
  const v = MessageMedia.render([video('v')]).markup;
  assert.match(v, /<video[^>]*controls/);
  assert.match(v, /src="\/__files\/v"/);
  assert.match(v, /v\.mp4/, '应显示文件名');
  const a = MessageMedia.render([{ id: 'au', original: { id: 'au', name: '录音.mp3', mimeType: 'audio/mpeg', fileStored: true } }]).markup;
  assert.match(a, /<audio[^>]*controls/);
});

test('安全：文件名的标记字符一律转义', () => {
  const html = MessageMedia.render([{ id: 'x', original: { id: 'x', name: '<img src=x onerror=1>.png', mimeType: 'image/png', fileStored: true } }]).markup;
  assert.doesNotMatch(html, /<img\s+src=x/, '文件名不得注入标签');
  assert.match(html, /&lt;img/, '应转义为实体');
});

test('render 不修改输入数据（只在渲染时分类）', () => {
  const items = [image('a'), video('v')];
  const snapshot = JSON.stringify(items);
  MessageMedia.render(items);
  assert.equal(JSON.stringify(items), snapshot, '附件对象一个字都不该变');
});
