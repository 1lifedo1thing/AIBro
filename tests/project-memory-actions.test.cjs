'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),React=require('react'),esbuild=require('esbuild');
const source=fs.readFileSync(require.resolve('../app/ui/project-memory-actions.jsx'),'utf8');
function fixture(lang='zh'){
 const module={exports:{}};
 vm.runInNewContext(esbuild.transformSync(source,{loader:'jsx',format:'cjs'}).code,{module,exports:module.exports,document:{documentElement:{lang},getElementById:()=>true},require:id=>id==='react'?React:id.endsWith('.css')?'':{Button:'Kit:Button'}});
 return module.exports.ProjectMemoryActions;
}
const buttons=node=>React.Children.toArray(node.props.children).flat(Infinity).filter(item=>React.isValidElement(item)&&item.type==='Kit:Button');
test('three project-record shortcuts use imported Kit buttons and retain exact click anchors',()=>{
 const calls=[],tree=fixture()({onOpen:(...args)=>calls.push(args)}),items=buttons(tree);assert.equal(tree.props.role,'group');assert.equal(tree.props['aria-label'],'项目记录');assert.deepEqual(items.map(item=>item.props.children),['项目记忆','计划与产出','进展日记']);const anchor={};items.forEach(item=>item.props.onClick({currentTarget:anchor}));assert.deepEqual(calls.map(([kind])=>kind),['long','plan','daily']);assert.ok(calls.every(([,value])=>value===anchor));assert.ok(items.every(item=>item.props.variant==='ghost'));
});
test('saving disables real Kit controls and exposes pending state without a fake completion',()=>{
 const tree=fixture()({busy:true,onOpen(){},onAutomation(){}});assert.equal(tree.props['aria-busy'],true);assert.equal(buttons(tree).length,4);assert.ok(buttons(tree).every(item=>item.props.disabled));
});
test('automatic tasks stay an optional callback and English labels remain explicit',()=>{
 const calls=[],render=fixture('en'),tree=render({onOpen(){},onAutomation:anchor=>calls.push(anchor)}),items=buttons(tree);assert.deepEqual(items.map(item=>item.props.children),['Project memory','Plan & outputs','Daily progress','Automatic tasks']);const anchor={};items[3].props.onClick({currentTarget:anchor});assert.deepEqual(calls,[anchor]);assert.equal(buttons(render({onOpen(){}})).length,3);assert.ok(buttons(render({})).every(item=>item.props.disabled));
});
