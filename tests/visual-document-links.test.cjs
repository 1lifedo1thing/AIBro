'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{transformSync}=require('esbuild'),vue=require('vue');
const source=fs.readFileSync(require.resolve('../app/editor/visual-editor.js'),'utf8');
let install, PreviewLink;
test.before(async()=>{
 const {safeDocumentUrl}=await import('../app/editor/visual-policy.mjs'),{sanitizeLinkHref}=await import('@milkdown/preset-commonmark');
 const scope={safeDocumentUrl};const start=source.indexOf('export function installDocumentLinkNavigation('),end=source.indexOf('// Crepe\'s link input');
 vm.runInNewContext(source.slice(start,end).replace('export function','function')+'\nthis.install=installDocumentLinkNavigation;',scope);install=scope.install;
 const upstream=fs.readFileSync(require('node:path').resolve(__dirname,'../node_modules/@milkdown/components/src/link-tooltip/preview/component.tsx'),'utf8'),module={exports:{}};
 const compiled=transformSync(upstream,{loader:'tsx',format:'cjs',jsxFactory:'h',jsxFragment:'Fragment'}).code;
 vm.runInNewContext(compiled,{module,exports:module.exports,require:id=>id==='vue'?vue:id==='@milkdown/preset-commonmark'?{sanitizeLinkHref}:id.includes('keep-alive')?{keepAlive(){}}:{Icon:()=>null}});PreviewLink=module.exports.PreviewLink;
});
const settle=async()=>{for(let i=0;i<6;i++)await Promise.resolve();};
function fixture(options={}) {
 let listener,available=true;const opened=[],errors=[];
 const outer={isConnected:true,contains:node=>node.owner===outer,addEventListener(type,fn,capture){assert.equal(type,'click');assert.equal(capture,true);listener=fn;},removeEventListener(_type,fn){if(listener===fn)listener=null;}};
 const dispose=install(outer,{isAvailable:()=>available,onError:error=>errors.push(error.message),...(options.noOwner?{}:{onOpenDocumentLink:options.open||((url,navigation)=>opened.push({url,navigation}))})});
 const anchor=(url,explicit=true)=>{
  const vnode=PreviewLink.setup({config:vue.ref({}),src:vue.ref(url),onEdit:vue.ref(()=>{}),onRemove:vue.ref(()=>{})})().children.find(child=>child.type==='a');
  assert.equal(vnode.props.target,'_blank');
  const node={owner:outer,href:vnode.props.href,matches:selector=>explicit&&selector==='.link-preview a.link-display',getAttribute:key=>key==='href'?node.href:null,closest:selector=>selector==='a[href]'?node:null};return node;
 };
 const click=(node,detail=1)=>{const event={target:node,detail,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}};listener?.(event);return event;};
 return{outer,opened,errors,anchor,click,dispose,available:value=>{available=value;}};
}
test('real Crepe preview anchor relative href is routed to the owned document callback for pointer and keyboard click',async()=>{
 for(const detail of [1,0]){const h=fixture(),a=h.anchor('../second.md#章节');assert.equal(a.href,'../second.md#章节');const event=h.click(a,detail);await settle();assert.equal(event.prevented,true);assert.equal(event.stopped,true);assert.equal(h.opened.length,1);assert.equal(h.opened[0].url,a.href);assert.equal(h.opened[0].navigation.anchor,a);assert.equal(h.opened[0].navigation.isCurrent(),true);h.dispose();}
});
test('HTTPS, mail and phone keep their external behavior while note-local and unsafe links never escape',async()=>{
 const h=fixture();for(const url of ['https://example.org','http://example.org','mailto:hi@example.org','tel:+123'])assert.equal(h.click(h.anchor(url)).prevented,undefined,url);assert.equal(h.opened.length,0);
 const note=fixture({noOwner:true});const event=note.click(note.anchor('second.md'));await settle();assert.equal(event.prevented,true);assert.equal(note.opened.length,0);assert.match(note.errors[0],/没有可用的文档位置/);
 for(const url of ['file:///etc/passwd','javascript:alert(1)','data:text/html,hello','//host/x']){const event=h.click(h.anchor(url));assert.equal(event.prevented,true,url);}await settle();assert.equal(h.opened.length,0);
});
test('ordinary prose clicks and input controls stay editing actions, including composition-blocked activation',async()=>{
 const h=fixture(),event=h.click(h.anchor('second.md',false));await settle();assert.equal(event.prevented,true);assert.equal(event.stopped,undefined);assert.equal(h.opened.length,0);
 const input={closest:()=>null};assert.equal(h.click(input).prevented,undefined);
 h.available(false);const composing=h.click(h.anchor('second.md'));await settle();assert.equal(composing.prevented,true);assert.equal(h.opened.length,0);assert.equal(h.errors.length,0);
});
test('later rich-link activation and teardown cancel prior navigation authority and suppress stale failure',async()=>{
 const h=fixture(),a=h.anchor('a.md'),b=h.anchor('b.md');h.click(a);await settle();h.click(b);await settle();assert.equal(h.opened[0].navigation.isCurrent(),false);assert.equal(h.opened[1].navigation.isCurrent(),true);h.dispose();assert.equal(h.opened[1].navigation.isCurrent(),false);
 let reject;const late=fixture({open:()=>new Promise((_resolve,no)=>{reject=no;})});late.click(late.anchor('missing.md'));await settle();late.dispose();reject(Error('late'));await settle();assert.deepEqual(late.errors,[]);
});
test('failed safe document open reports its actual error without allowing browser navigation',async()=>{
 const h=fixture({open:async()=>{throw Error('文件不存在，当前文档仍保留。');}}),event=h.click(h.anchor('missing.md'));await settle();assert.equal(event.prevented,true);assert.match(h.errors[0],/文件不存在/);
});
