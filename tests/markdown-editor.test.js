const test=require('node:test'),assert=require('node:assert/strict'),M=require('../app/markdown-editor');
test('block parsing preserves every byte of mixed and unusual Markdown documents',()=>{
  for(const source of ['', '\n\n', '\uFEFF---\r\nid: n\r\ntitle: 文档\r\n---\r\n\r\n# 标题  ##\r\n\r\n段落 **粗体**\r\n\r\n- 第一项\r\n- 第二项\r\n', '```js\nline\n\nline\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n> 引用\n\n![图](a.png)\n', '# a\ntext\n## b\n- first\n- second', '未结束代码\n\n~~~~markdown\n# still code\n\n'] )assert.equal(M.parse(source).map(block=>block.raw).join(''),source);
});
test('only safely editable blocks enter rich editing and nested structures retain their source',()=>{
  const blocks=M.parse('---\nid: note\n---\n\n# 标题\n\n支持 **粗体**、*斜体*、`x()` 与 [链接](https://example.org)。\n\n- 简单\n- 列表\n\n- parent\n  - nested\n\n- [x] task\n\n$$\nx+y\n$$\n\n[doc][ref]\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');
  assert.deepEqual(blocks.filter(block=>block.type!=='gap').map(block=>block.type),['locked','heading','paragraph','list','locked','locked','locked','locked','locked']);
  assert.equal(blocks[0].metadata,true);assert.equal(M.inlineTokens('[unsafe](javascript:alert)'),null);
});
test('an edited paragraph changes only its block while frontmatter, CRLF and code remain exact',()=>{
  const source='---\r\ntitle: "Keep  spacing"\r\n---\r\n\r\nA **bold** paragraph.\r\n\r\n```txt\r\n<literal>  \r\n```\r\n',blocks=M.parse(source),paragraph=blocks.find(block=>block.type==='paragraph');
  paragraph.changed=M.replaceBlock(paragraph,'Changed **bold** paragraph.');
  assert.equal(blocks.map(block=>block.changed??block.raw).join(''),source.replace('A **bold** paragraph.','Changed **bold** paragraph.'));
  assert.equal(M.replaceBlock({raw:'no final newline'},'edited'),'edited');
});
test('inline code and Markdown escaping preserve literal user text and reject unsafe link schemes',()=>{
  assert.equal(M.codeSpan('x`y'),'``x`y``');assert.equal(M.codeSpan('`x`'),'`` `x` ``');assert.equal(M.codeSpan(' x '),'`  x  `');
  assert.equal(M.escapeText('# text\n- item\n<literal> **stars**'),'\\# text\n\\- item\n\\<literal\\> \\*\\*stars\\*\\*');
  for(const bad of ['javascript:alert(1)','data:text/html,x','vbscript:x','//evil.example','https://example.org\nscript'])assert.equal(M.safeLink(bad),null);
  for(const good of ['https://example.org','mailto:user@example.org','#heading','../doc.md','docs/note.md'])assert.equal(M.safeLink(good),good);
});
test('heading hashes and link titles retain literal content, and fence-like code does not end a block',()=>{
  assert.equal(M.parse('# literal#\n')[0].tokens[0].value,'literal#');
  assert.equal(M.parse('# title ##\n')[0].tokens[0].value,'title');
  assert.equal(M.inlineTokens('[label](https://example.org "Title")')[0].title,'Title');
  const source='```md\n```not-a-close\n# still code\n```\n\nParagraph.';
  const blocks=M.parse(source);assert.equal(blocks[0].type,'locked');assert.equal(blocks[0].raw,'```md\n```not-a-close\n# still code\n```\n');assert.equal(blocks.at(-1).type,'paragraph');
});
