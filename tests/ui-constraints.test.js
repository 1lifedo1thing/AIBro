const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(ROOT,file),'utf8');

// 这些约束来自历轮真实踩过的坑：图标名拼错会静默退回默认图标、重复 id 会让既有代码命中错误节点。
function definedIcons() {
  const source=read('app/icons.js');
  return new Set([...source.matchAll(/"([a-zA-Z][a-zA-Z0-9]*)":\s*"/g)].map(match=>match[1]));
}

test('静态界面引用的图标都已定义',()=>{
  const defined=definedIcons();
  const used=[...read('app/index.html').matchAll(/data-icon="([^"]+)"/g)].map(match=>match[1]);
  assert.ok(used.length>0,'应当能从界面里读到图标引用');
  const missing=[...new Set(used)].filter(name=>!defined.has(name));
  assert.deepEqual(missing,[],'未定义的图标（会静默退回默认图标）：'+missing.join('、'));
});

test('脚本里动态创建的图标都已定义',()=>{
  const defined=definedIcons();
  const missing=new Set();
  for (const file of fs.readdirSync(path.join(ROOT,'app')).filter(name=>name.endsWith('.js'))) {
    const text=read('app/'+file);
    for (const match of text.matchAll(/(?:uiIcon|\bicon)\(\s*'([^']+)'\s*\)/g)) {
      if (!defined.has(match[1])) missing.add(`${match[1]}（${file}）`);
    }
  }
  assert.deepEqual([...missing],[],'未定义的图标：'+[...missing].join('、'));
});

test('静态界面的 id 唯一',()=>{
  const ids=[...read('app/index.html').matchAll(/(?:^|[^-\w])id="([^"]+)"/g)].map(match=>match[1]);
  const duplicates=[...new Set(ids.filter((id,index)=>ids.indexOf(id)!==index))];
  assert.deepEqual(duplicates,[],'重复 id（会让既有代码命中错误节点）：'+duplicates.join('、'));
});

test('界面里的静态文案节点都带 data-i18n，便于英文界面完整翻译',()=>{
  const html=read('app/index.html');
  // 只检查新增的底部终端区域内联文案：其余区域的翻译完整性由 i18n 测试覆盖。
  const pane=html.slice(html.indexOf('class="terminal-pane"'),html.indexOf('</section>',html.indexOf('class="terminal-pane"')));
  assert.ok(pane.includes('data-i18n'),'终端区域的界面文案应带 data-i18n');
  assert.ok(pane.includes('data-i18n-attrs'),'终端区域的 aria-label 应带 data-i18n-attrs');
});

test('使用 root.X 的模块必须真的收到 root（IIFE 形态不一致会抛 root is not defined）',()=>{
  // 踩过的坑：workstation-core 的工厂函数不接收 root，照抄别的模块写 root.X
  // 会让真实运行抛 "root is not defined"，而单元测试照样全绿（核心模块被沙箱化）。
  const dir=path.join(ROOT,'app');
  const risky=[];
  for(const name of fs.readdirSync(dir)){
    if(!name.endsWith('.js'))continue;
    const source=read(path.join('app',name));
    // record.root is an object property (for example a React root), not the
    // free root variable this guard protects.
    if(!/(?<![\w$.])root\.[A-Za-z_]/.test(source))continue;
    const receives=/(factory\(\s*root\s*\))|(,\s*\(?\s*root\s*\)?\s*=>)|(function\s*\(\s*root\s*[,)])/.test(source);
    if(!receives)risky.push(name);
  }
  assert.deepEqual(risky,[],`这些模块用了 root.X 但工厂拿不到 root：${risky.join('，')}`);
});

// 来源：插入新脚本标签时漏掉 </script>，会让其后所有脚本被当成前一个标签的文本、
// 静默不加载（页面只剩 DOM、没有任何应用逻辑）。这类损坏在浏览器里不报错，
// 只有真实渲染器的冒烟验收才能发现——所以在这里固化成静态检查。
test('script 标签必须配对：漏掉结束标签会让后续脚本静默不加载',()=>{
  const html=read('app/index.html');
  const opens=[...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)];
  const bad=opens.filter(match=>{
    const after=html.slice(match.index+match[0].length);
    return !after.startsWith('</script>');
  }).map(match=>match[1]);
  assert.deepEqual(bad,[],'这些 script 标签后面缺少 </script>：'+bad.join('、'));
  const closes=(html.match(/<\/script>/g)||[]).length;
  assert.equal(opens.length,closes,'script 开始标签与结束标签数量必须一致');
});

test('界面引用的样式表文件都存在',()=>{
  const html=read('app/index.html');
  const links=[...html.matchAll(/<link[^>]*href="([^"]+\.css)"[^>]*>/g)];
  assert.ok(links.length>0,'应当能从界面里读到样式表引用');
  // link 是 void 元素，HTML5 下自闭合与否都合法（既有代码两种写法都有），
  // 所以这里只校验引用目标真实存在——引用到不存在的样式表才是真问题。
  for (const match of links) {
    assert.ok(fs.existsSync(path.join(ROOT,'app',match[1])),`样式表不存在：${match[1]}`);
  }
});
