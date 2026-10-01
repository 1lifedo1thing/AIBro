'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),esbuild=require('esbuild');
const compiled=esbuild.transformSync(fs.readFileSync(require.resolve('../app/ui/citation-surfaces.jsx'),'utf8'),{loader:'jsx',format:'cjs'}).code;
// Render the actual citation components; only established Kit primitives are
// lightweight semantic stand-ins. No production bundle, assets, or GUI is built.
const primitives={Badge:({children})=>React.createElement('span',{className:'kit-badge'},children),Caption:({children})=>React.createElement('small',null,children),
 Button:({children,id,disabled,loading,onClick,...props})=>React.createElement('button',{id,type:'button',disabled:!!disabled||!!loading,'aria-label':props['aria-label'],onClick},children)};
function render(name,props,language='zh'){
 const module={exports:{}};vm.runInNewContext(compiled,{module,exports:module.exports,document:{documentElement:{lang:language}},require:id=>id==='react'?React:primitives});
 return renderToStaticMarkup(React.createElement(module.exports[name],props));
}
const omitted=(patch={})=>({sourceId:'stable-late-137',number:137,title:'第137页材料',provided:true,excerptState:'omitted',excerpt:null,excerptCharacters:5400,location:'第 137 页',status:{kind:'unretained',canOpen:true,notice:'正文预算超出，未保存摘录；当前源可打开，但不能还原旧片段。'},...patch});
const openTag=html=>html.match(/<button\b[^>]*id="citationOpenOriginal"[^>]*>/)?.[0];
test('excerpt budget notice keeps the citation identity and distinguishes it from missing historical mappings',()=>{
 const html=render('CitationSourceList',{sources:[omitted()],excerptLimited:true});
 assert.match(html,/来源编号已完整保留，部分正文摘录未保存/);assert.match(html,/>137<\/span>/);assert.match(html,/来源编号已保留 · 文字摘录未保存/);
 assert.match(html,/正文预算超出/);assert.match(html,/不代表支持回答中的每个判断/);
 assert.doesNotMatch(html,/无引用映射|未生成可追溯引用编号|已提供文字片段|旧版记录/);
});
test('omitted peek never substitutes current or legacy preview text for the unretained request passage',()=>{
 const source=omitted({legacyPreview:'STALE_LEGACY',excerpt:'STALE_EXCERPT'}),html=render('CitationPeek',{source,status:source.status,location:source.location});
 assert.match(html,/无法在此还原当时提供的片段/);assert.match(html,/当前源可打开/);assert.doesNotMatch(html,/STALE_|没有保存可复制/);
 assert.ok(openTag(html));assert.doesNotMatch(openTag(html),/disabled/);
 const missing=render('CitationPeek',{source,status:{kind:'missing',canOpen:false,notice:'原件已移除'},location:source.location});assert.match(missing,/原件已移除/);assert.match(openTag(missing),/disabled/);
});
test('private access overrides omitted labels and hides stale titles, excerpts, locations and errors',()=>{
 for(const flag of ['status','source']){
  const source=omitted({title:'SECRET_TITLE',excerpt:'SECRET_EXCERPT',legacyPreview:'SECRET_LEGACY',location:'SECRET_LOCATION'});
  if(flag==='status')source.status={kind:'private',canOpen:false,notice:'已隐藏'};else source.private=true;
  const peek=render('CitationPeek',{source,status:source.status,location:source.location,error:'SECRET_ERROR'}),list=render('CitationSourceList',{sources:[source],excerptLimited:true});
  assert.doesNotMatch(peek,/SECRET_|无法在此还原当时/);assert.match(peek,/私密来源/);assert.match(openTag(peek),/disabled/);
  assert.doesNotMatch(list,/SECRET_|正文预算超出|来源编号已保留 · 文字摘录未保存/);assert.match(list,/标题与摘录已隐藏/);
 }
});
test('old mapping limits remain historical and do not claim excerpt-only retention is complete',()=>{
 const html=render('CitationSourceList',{limited:true,sources:[]});assert.match(html,/旧版记录/);assert.match(html,/不会补造历史引用编号/);assert.doesNotMatch(html,/来源编号已完整保留/);
});
test('retained excerpts, file and page-image cases retain their distinct actual-content presentation',()=>{
 const retained=omitted({excerptState:'retained',excerpt:'Literal <BOS> & complete',status:{kind:'current',canOpen:true,notice:'版本一致'}});
 const html=render('CitationPeek',{source:retained,status:retained.status});assert.match(html,/Literal &lt;BOS&gt; &amp; complete/);assert.doesNotMatch(html,/正文摘录未保存/);
 for(const [media,expected]of [['page_image','此页图像'],['file','原始文件']]){const source={provided:true,title:'Original',media};assert.match(render('CitationPeek',{source,status:{kind:'current',canOpen:true,notice:'已提供'}}),new RegExp(expected));}
});
test('English excerpt-only states remain explicit and existing pagination stays bounded',()=>{
 const html=render('CitationSourceList',{sources:Array.from({length:45},(_,i)=>omitted({sourceId:'id-'+i,number:i+1,title:'Title '+i})),excerptLimited:true},'en');
 assert.match(html,/All citation identifiers were retained/);assert.match(html,/Citation identifier retained · text excerpt not saved/);assert.match(html,/does not establish support for every claim/);
 assert.equal((html.match(/<li\b/g)||[]).length,20);assert.match(html,/1 \/ 3/);assert.doesNotMatch(html,/Title 20/);
 const source=omitted(),peek=render('CitationPeek',{source,status:source.status},'en');assert.match(peek,/originally supplied passage cannot be reconstructed here/);assert.match(peek,/Open original/);
});
test('attachment details also suppress stale private titles while preserving the generic source entry',()=>{
 const source=omitted({private:true,title:'SECRET_ATTACHMENT'});
 const html=render('CitationSourceList',{attachments:{metrics:[],sources:[source],notes:[]}});
 assert.doesNotMatch(html,/SECRET_ATTACHMENT/);assert.match(html,/私密来源/);assert.match(html,/<button[^>]*disabled/);
});
test('an older run with new omitted excerpts never upgrades lost mappings into complete identity coverage',()=>{
 const html=render('CitationSourceList',{sources:[omitted()],limited:true,excerptLimited:true});
 assert.match(html,/新增记录的来源编号已保留/);assert.match(html,/旧版缺失映射仍不可恢复/);assert.doesNotMatch(html,/来源编号已完整保留/);
 const english=render('CitationSourceList',{sources:[omitted()],limited:true,excerptLimited:true},'en');assert.match(english,/newly recorded sources/);assert.match(english,/remain unrecoverable/);assert.doesNotMatch(english,/All citation identifiers were retained/);
});
