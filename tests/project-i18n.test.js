const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),React=require('react'),esbuild=require('esbuild');
const source=fs.readFileSync(require.resolve('../app/app.js'),'utf8'),dictionary=require('../app/i18n-en');
const index=fs.readFileSync(require.resolve('../app/index.html'),'utf8');
const librarySource=fs.readFileSync(require.resolve('../app/project-library.js'),'utf8');
const surfacesSource=fs.readFileSync(require.resolve('../app/ui/project-surfaces.jsx'),'utf8');
const compiledSurfaces=esbuild.transformSync(surfacesSource,{loader:'jsx',format:'cjs'}).code;
function translate(value){if(Object.hasOwn(dictionary.exact,value))return dictionary.exact[value];for(const rule of dictionary.patterns){const regex=new RegExp(rule.source);if(regex.test(value))return value.replace(regex,rule.replacement);}return value;}
function render(overrides={},analysisStatus='analyzed'){
 const nodes=new Map(),mounts=new Map(),collections=[],overviews=[],activities=[],planning=[],notices=[],state={currentProjectId:'p',projects:[{id:'p',name:'知识库',workspace:'课程',description:'项目状态'}],tasks:[{id:'t',title:'尚未开始',workspace:'课程',projectId:'p',status:'todo',priority:'medium',dueAt:'2026-09-15T10:00:00Z'}],notes:[{id:'n',title:'规划与任务',kind:'User category',workspace:'课程',projectId:'p',content:'知识条目',folderPath:'规划与任务'}],imports:[],papers:[],conversations:[],...overrides};
 // These hosts only capture render contracts. The real library controller
 // supplies its model and callbacks; it no longer emits a flat HTML tree.
 const get=selector=>{if(!nodes.has(selector))nodes.set(selector,{dataset:{},innerHTML:'',textContent:'',hidden:false,open:false,clicks:0,classList:{add(){},remove(){},toggle(){}},setAttribute(){},toggleAttribute(){},replaceChildren(){},replaceWith(){},prepend(){},append(){},before(){},remove(){},click(){this.clicks++;},querySelectorAll(){return[];},querySelector:child=>get(selector+' '+child),closest:parent=>get(selector+' closest('+parent+')')});return nodes.get(selector);};
 const original=JSON.stringify(state);
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const HalaskaUI={mount(host,name,props){mounts.set(name,{host,props});},unmount(){}},CollectionUI={render(host,options){collections.push({host,options});}};
 // Exercise the actual host adapter, capturing its public controller seam.
 // The separate overview model/component tests own their rendering behavior.
 const ProjectOverview={mount(host,options){overviews.push({host,options,method:'mount'});return{update(next){overviews.push({host,options:next,method:'update'});}};}};
 const ActivityUI={render(host,current,options){activities.push({host,state:current,options});}};
 const context=vm.createContext({state,$:get,document:{body:{dataset:{view:'project'}}},HalaskaUI,window:{HalaskaUI,CollectionUI,ProjectOverview,ActivityUI,WorkstationActivityCore:{},matchMedia:()=>({matches:false})},requestAnimationFrame(){},updateProjectHeading(){},workspaceName:x=>x,esc,orderTasks:x=>x,visibleTask:()=>true,visibleNote:()=>true,visibleImport:()=>true,visiblePaper:()=>true,conversationProjectIds:c=>[c.projectId],formatDate:()=> '2026/9/15 GMT+8 18:00',formatRelative:()=> '刚刚更新',statusLabel:()=> '待开始',priorityLabel:()=> '中',uiIcon:()=>'',importAnalysis:()=>({status:analysisStatus}),analysisBadge:()=>'',setEntityBox:(selector,html)=>get(selector).innerHTML=html,entityTask:()=>'',entityNote:()=>'',entityImport:()=>'',renderPlanning(view,scope){planning.push({view,scope});},openActivityEntity(){},toast:message=>notices.push(message),applySectionTabs(){},save(){}});
 vm.runInContext(librarySource,context);context.window.ProjectLibrary=context.ProjectLibrary;
 vm.runInContext(source.slice(source.indexOf('let projectOverviewController ='),source.indexOf('function updateProjectHeading(')),context);context.renderProject('p');return{state,nodes,get,original,mounts,collections,overviews,activities,planning,notices,rerender(id='p'){state.currentProjectId=id;context.renderProject(id);}};
}
function surfaces(lang='zh'){
 const module={exports:{}},react={...React,useLayoutEffect(){},useRef:()=>({current:null})};
 const kit=Object.fromEntries(['Button','Badge','Caption','Card','Stat','Progress','EmptyState'].map(name=>[name,'Kit:'+name]));
 const controls=Object.fromEntries(['KitSearchInput','KitSelect','KitSegmentedControl'].map(name=>[name,'Kit:'+name]));
 vm.runInNewContext(compiledSurfaces,{module,exports:module.exports,document:{documentElement:{lang},createElement:()=>({}),head:{append(){}}},require:id=>id==='react'?react:id.endsWith('.css')?'':id.endsWith('kit-controls.jsx')?controls:kit});return module.exports;
}
function expand(node){if(!React.isValidElement(node))return node;if(typeof node.type==='function')return expand(node.type(node.props));return React.cloneElement(node,{},...React.Children.toArray(node.props.children).map(expand));}
function descendants(node){return React.isValidElement(node)?[node,...React.Children.toArray(node.props.children).flatMap(descendants)]:[];}
function text(node){return typeof node==='string'||typeof node==='number'?String(node):React.isValidElement(node)?React.Children.toArray(node.props.children).map(text).join(''):'';}
test('actual populated project header, overview host and mounted library preserve UI and user-content boundaries',()=>{
 const h=render(),before=h.original,html=['#projectWorkspace','#projectSectionCaption'].map(key=>h.get(key).innerHTML).join('');
 const labels=[...html.matchAll(/<[^>]*\bdata-i18n(?=\s|>)[^>]*>([^<>]+)</g)].map(match=>match[1]);
 for(const label of labels.filter(x=>/[\u3400-\u9fff]/.test(x)))assert.notEqual(translate(label),label,'Untranslated project UI: '+label);
 for(const key of ['课程空间','项目','1 篇笔记','0 份原始资料'])assert.ok(labels.includes(key),'Missing explicit interface marker: '+key);
 const navigation=h.mounts.get('ProjectLibraryNavigation'),breadcrumb=h.mounts.get('ProjectLibraryBreadcrumb');
 assert.equal(navigation.props.projectId,'p');assert.equal(navigation.props.model.count,1);assert.equal(navigation.props.model.roots[0].label,'规划与任务');assert.equal(navigation.props.model.roots[0].path,'规划与任务');assert.equal(breadcrumb.props.model.selected,null);assert.equal(navigation.host,h.get('#projectLibraryNavigation'));
 assert.equal(h.get('#projectTitle').textContent,'知识库');assert.equal(h.get('#projectDescription').textContent,'项目状态');assert.match(h.get('#currentContext').innerHTML,/<span data-user-content>知识库<\/span>/);
 const overview=h.overviews[0];assert.equal(overview.host,h.get('#projectOverview'));assert.equal(overview.method,'mount');assert.equal(overview.options.state(),h.state);assert.equal(overview.options.projectId(),'p');
 assert.equal(overview.options.state().tasks[0].title,'尚未开始');assert.equal(overview.options.state().notes[0].title,'规划与任务');assert.equal(overview.options.formatDate(h.state.tasks[0].dueAt),'2026/9/15 GMT+8 18:00');assert.equal(overview.options.formatRelative(0),'刚刚更新');overview.options.toast('验收提示');assert.deepEqual(h.notices,['验收提示']);
 assert.equal(JSON.stringify(h.state),before);assert.equal(h.state.ui,undefined,'legacy snapshots are rendered without adding UI fields');
});
test('empty and completed project variants localize without arbitrary title or date regex capture',()=>{
 const empty=render({tasks:[],notes:[]}),done=render({tasks:[{id:'done',projectId:'p',status:'done'}]});
 for(const h of [empty,done]){assert.equal(h.overviews.length,1);for(const html of [h.get('#projectWorkspace').innerHTML,h.get('#projectSectionCaption').innerHTML])for(const match of html.matchAll(/<[^>]*\bdata-i18n>([^<>]+)</g)){const label=match[1];if(/[\u3400-\u9fff]/.test(label))assert.notEqual(translate(label),label);}}
 assert.equal(translate('还有 12 项待推进'),'12 open tasks remaining');assert.equal(translate('已完成 1 项'),'1 completed');assert.equal(translate('项目状态：还有 12 项待推进'),'项目状态：还有 12 项待推进');assert.equal(translate('我的知识库'),'我的知识库');assert.equal(translate('2026/9/15 GMT+8 18:00'),'2026/9/15 GMT+8 18:00');
});

test('project source actions and collection scope replace removed banners without rewriting source names',()=>{
 const imports=[1,2,3].map(n=>({id:'original-'+n,name:'资料库',workspace:'课程',projectId:'p',content:'原件已保存'}));
 const h=render({imports},'pending'),actions=h.mounts.get('ProjectSourceActions'),collection=h.collections.at(-1);
 assert.equal(h.nodes.has('#projectPendingAnalysis'),false);assert.equal(h.nodes.has('#projectLocalSummary'),false);
 assert.equal(actions.host,h.get('#projectSourceActions'));assert.equal(actions.props.connected,false);assert.equal(typeof actions.props.onConnect,'function');
 assert.equal(collection.options.projectId,'p');assert.equal(collection.options.workspace,'课程');assert.deepEqual(Array.from(collection.options.types),['note','import','paper']);assert.equal(collection.options.folderPath,null);assert.equal(collection.options.onAdd,actions.props.onAdd);
 assert.equal(h.mounts.get('ProjectLibraryNavigation').props.model.count,4);assert.ok(h.state.imports.every(item=>item.name==='资料库'&&item.content==='原件已保存'));
 assert.match(h.get('#projectSectionCaption').innerHTML,/<span data-i18n>3 份原始资料<\/span>/);assert.notEqual(translate('3 份原始资料'),'3 份原始资料');
 actions.props.onAdd();assert.equal(h.get('#projectLibraryInput').clicks,1);assert.equal(h.get('#projectLibraryInput').dataset.projectId,'p');
});

test('zero-task and populated projects both mount the overview while insights stay closed and unloaded',()=>{
 const h=render({tasks:[]}),empty=render({tasks:[],notes:[]}),populated=render();
 const details=index.match(/<details\b[^>]*\bid="projectInsights"[^>]*>/)?.[0];assert.ok(details);assert.doesNotMatch(details,/\sopen(?:\s|=|>)/);
 for(const sample of [h,empty,populated]){
  assert.equal(sample.overviews.length,1);assert.equal(sample.overviews[0].options.projectId(),'p');assert.equal(sample.get('#projectInsights').open,false);assert.equal(sample.activities.length,0);assert.equal(sample.planning.length,0);
  for(const key of ['projectOnboarding','projectMetrics','projectSummary']){assert.equal(sample.nodes.has('#'+key),false);assert.doesNotMatch(index,new RegExp('id="'+key+'"'));}
  const callback=sample.overviews[0].options.onAddSources,input=sample.get('#projectLibraryInput');callback(()=>false);assert.equal(input.clicks,0);callback(()=>true);assert.equal(input.clicks,1);assert.equal(input.dataset.projectId,'p');
 }
 assert.equal(h.overviews[0].options.state().tasks.length,0);assert.equal(populated.overviews[0].options.state().tasks.length,1);
});

test('expanding insights uses the current project scope and closing leaves analytics unloaded',()=>{
 const h=render(),insights=h.get('#projectInsights');
 insights.ontoggle();assert.equal(h.activities.length,0);assert.equal(h.planning.length,0);
 insights.open=true;insights.ontoggle();
 assert.equal(h.activities.length,1);assert.equal(h.activities[0].host,h.get('#projectActivity'));assert.equal(h.activities[0].state,h.state);assert.equal(h.activities[0].options.projectId,'p');assert.equal(h.activities[0].options.workspace,'课程');assert.equal(h.activities[0].options.days,7);assert.equal(h.activities[0].options.getState(),h.state);
 assert.equal(h.planning.length,1);assert.equal(h.planning[0].view,'project');assert.equal(h.planning[0].scope.projectId,'p');assert.equal(h.planning[0].scope.workspace,'课程');
 insights.open=false;insights.ontoggle();assert.equal(h.activities.length,1);assert.equal(h.planning.length,1);
});

test('switching projects closes insights, rejects stale toggles and updates the retained overview controller',()=>{
 const h=render({projects:[{id:'p',name:'知识库',workspace:'课程'},{id:'q',name:'尚未开始',workspace:'科研'}]}),insights=h.get('#projectInsights');
 insights.open=true;insights.ontoggle();const staleToggle=insights.ontoggle;
 h.rerender('q');assert.equal(insights.open,false);assert.equal(insights.dataset.projectId,'q');assert.equal(h.activities.length,1);assert.equal(h.planning.length,1);
 assert.equal(h.overviews.length,2);assert.equal(h.overviews[1].method,'update');assert.equal(h.overviews[1].host,h.overviews[0].host);assert.equal(h.overviews[1].options.projectId(),'q');assert.equal(h.get('#projectTitle').textContent,'尚未开始');
 insights.open=true;staleToggle();assert.equal(h.activities.length,1);assert.equal(h.planning.length,1);
 insights.ontoggle();assert.equal(h.activities.length,2);assert.equal(h.activities[1].options.projectId,'q');assert.equal(h.activities[1].options.workspace,'科研');assert.equal(h.planning[1].scope.projectId,'q');assert.equal(h.planning[1].scope.workspace,'科研');
 h.rerender('q');assert.equal(insights.open,true,'same-project updates preserve an explicitly opened disclosure');assert.equal(h.overviews.at(-1).method,'update');
});

test('connected local folder labels remain literal in the sidebar and source actions receive the true binding state',()=>{
 const h=render({projects:[{id:'p',name:'知识库',workspace:'课程',description:'项目状态',localFolder:{id:'folder-p',name:'添加资料 <原件>',path:'/Users/fixture/连接本机目录'}}]});
 assert.equal(h.mounts.get('ProjectSourceActions').props.connected,true);assert.equal(h.nodes.has('#projectLocalSummary'),false);
 assert.equal(h.get('#projectTree .project-local-directory .project-local-directory-name').textContent,'添加资料 <原件>');assert.equal(h.get('#projectTree .project-local-directory summary').title,'/Users/fixture/连接本机目录');
 assert.equal(JSON.stringify(h.state),h.original);
});

test('actual ProjectSourceActions JSX localizes fixed labels, hides redundant connect and keeps direct callbacks',()=>{
 for(const lang of ['zh','en']){
  const f=surfaces(lang),calls=[],tree=expand(f.ProjectSourceActions({connected:false,onAdd:()=>calls.push('add'),onConnect:()=>calls.push('connect')}));
  const buttons=descendants(tree).filter(node=>node.type==='Kit:Button');assert.equal(buttons.length,2);
  assert.equal(tree.props['aria-label'],lang==='zh'?'添加项目资料':'Add project sources');assert.equal(text(buttons[0]),lang==='zh'?'添加资料':'Add sources');assert.equal(text(buttons[1]),lang==='zh'?'连接本机目录':'Connect local folder');
  buttons[0].props.onClick();buttons[1].props.onClick();assert.deepEqual(calls,['add','connect']);
  const connected=expand(f.ProjectSourceActions({connected:true,onAdd(){},onConnect(){}}));assert.equal(descendants(connected).filter(node=>node.type==='Kit:Button').length,1);assert.doesNotMatch(text(connected),/连接本机目录|Connect local folder/);
 }
});

test('actual library toolbar localizes pending filter labels without interpreting literal query or custom type labels',()=>{
 for(const lang of ['zh','en']){
  const f=surfaces(lang),calls=[],query='资料库 <img src=x> & 待 AI 分析',options={query,type:'all',types:[{value:'all'},{value:'note'},{value:'custom',label:'全部资料 <个人分类>'}],sortLabel:'名称',view:'list',count:4,pendingCount:3,onQuery(){},onType(){},onSort(){},onView(){},onPending:()=>calls.push('filter')};
  const tree=expand(f.LibraryToolbar(options)),nodes=descendants(tree),pending=nodes.find(node=>node.type==='Kit:Button'&&String(node.props['aria-label']).includes(lang==='zh'?'待分析原始资料':'sources awaiting analysis'));
  assert.equal(text(pending),lang==='zh'?'待分析 3':'Awaiting analysis 3');assert.equal(pending.props['aria-label'],lang==='zh'?'查看 3 份待分析原始资料':'View 3 sources awaiting analysis');assert.match(pending.props.title,lang==='zh'?/不会开始 AI 分析/:/does not start AI analysis/);pending.props.onClick();assert.deepEqual(calls,['filter']);
  assert.equal(nodes.find(node=>node.type==='Kit:KitSearchInput').props.value,query);
  const types=nodes.find(node=>node.type==='Kit:KitSelect').props.options;assert.equal(types[0].label,lang==='zh'?'全部类型':'All types');assert.equal(types[1].label,lang==='zh'?'笔记':'Notes');assert.equal(types[2].label,'全部资料 <个人分类>');
  assert.equal(nodes.some(node=>node.type==='img'||node.props.dangerouslySetInnerHTML),false);
  const zero=expand(f.LibraryToolbar({...options,pendingCount:0}));assert.equal(descendants(zero).some(node=>node.type==='Kit:Button'&&String(node.props['aria-label']).includes(lang==='zh'?'待分析原始资料':'sources awaiting analysis')),false);
 }
});

test('actual empty-state JSX distinguishes adding sources from clearing a filter in both languages',()=>{
 for(const lang of ['zh','en']){
  const f=surfaces(lang),calls=[],plain=f.LibraryEmpty({filtered:false,onAdd:()=>calls.push('add'),onReset:()=>calls.push('reset')}),filtered=f.LibraryEmpty({filtered:true,onAdd:()=>calls.push('add'),onReset:()=>calls.push('reset')});
  assert.equal(plain.type,'Kit:EmptyState');assert.equal(plain.props.title,lang==='zh'?'暂无内容':'No items yet');assert.equal(text(plain.props.action),lang==='zh'?'添加资料':'Add sources');plain.props.action.props.onClick();
  assert.equal(filtered.props.title,lang==='zh'?'没有匹配内容':'No matching items');assert.equal(text(filtered.props.action),lang==='zh'?'清除筛选':'Clear filters');filtered.props.action.props.onClick();assert.deepEqual(calls,['add','reset']);
  assert.equal(f.LibraryEmpty({filtered:false}).props.action,undefined,'Global callers without a scoped import action do not gain a fabricated callback');
 }
});
