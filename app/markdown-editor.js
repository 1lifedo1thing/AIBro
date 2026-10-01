/* Block-local Markdown editing: an untouched block always retains its original bytes. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.MarkdownEditor=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const string=value=>String(value??'');
  const lineText=line=>line.replace(/\r?\n$/,'');
  const isGap=line=>/^\s*$/.test(lineText(line));
  const fence=line=>/^ {0,3}(`{3,}|~{3,})/.exec(lineText(line));
  const heading=line=>{const match=/^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(lineText(line));if(match)match[2]=match[2].replace(/[ \t]+#+[ \t]*$/,'').trim();return match;};
  const listLine=line=>/^ {0,3}([-+*]|\d+[.)])[ \t]+(.*)$/.exec(lineText(line));
  const rule=line=>/^ {0,3}(?:\*\s*){3,}$|^ {0,3}(?:-\s*){3,}$|^ {0,3}(?:_\s*){3,}$/.test(lineText(line));
  const boundary=line=>fence(line)||heading(line)||listLine(line)||rule(line)||/^ {0,3}>/.test(lineText(line));
  function safeLink(value){
    const url=string(value).trim();
    if(!url||/[\x00-\x20\x7f]/.test(url))return null;
    return /^(?:https?:\/\/|mailto:|tel:|#|\/(?!\/)|\.{1,2}\/)/i.test(url)||(!/^[\w+.-]+:/.test(url)&&!url.startsWith('//'))?url:null;
  }
  function inlineTokens(source,depth=0){
    source=string(source);if(depth>8||/!\[|\[\[|<\/?[a-z!]|\$[^$\n]+\$|\[\^[^\]]+\]|\[[^\]]+\]\s*\[/i.test(source))return null;
    const tokens=[];let plain='';const flush=()=>{if(plain){tokens.push({type:'text',value:plain});plain='';}};
    for(let i=0;i<source.length;){
      if(source[i]==='\\'&&i+1<source.length&&/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(source[i+1])){plain+=source[i+1];i+=2;continue;}
      if(source[i]==='`'){
        const run=/^`+/.exec(source.slice(i))[0],end=source.indexOf(run,i+run.length);
        if(end>=0){flush();let value=source.slice(i+run.length,end).replace(/\r?\n/g,' ');if(/^ .+ $/.test(value)&&/[^ ]/.test(value))value=value.slice(1,-1);tokens.push({type:'code',value});i=end+run.length;continue;}
      }
      let found=false;
      for(const mark of ['**','__','*','_']){
        if(!source.startsWith(mark,i)||mark.includes('_')&&i>0&&/\w/.test(source[i-1]))continue;
        const end=source.indexOf(mark,i+mark.length);
        if(end<=i+mark.length||/\s/.test(source[i+mark.length])||/\s/.test(source[end-1]))continue;
        const children=inlineTokens(source.slice(i+mark.length,end),depth+1);if(!children)return null;
        flush();tokens.push({type:mark.length===2?'strong':'em',children});i=end+mark.length;found=true;break;
      }
      if(found)continue;
      if(source[i]==='['){
        const match=/^\[([^\]\n]+)\]\((<[^>\n]+>|[^\s()]+)(?:\s+(["'])([^\n]*?)\3)?\)/.exec(source.slice(i));
        if(match){const href=safeLink(match[2].replace(/^<|>$/g,'')),children=inlineTokens(match[1],depth+1);if(!href||!children)return null;flush();tokens.push({type:'a',href,title:match[4],children});i+=match[0].length;continue;}
        // References and images are preserved through the source view.
        if(/\[[^\]]+\](?!\()/.test(source.slice(i)))return null;
      }
      plain+=source[i++];
    }
    flush();return tokens;
  }
  function parse(value){
    const source=string(value),lines=source.match(/[^\n]*\n|[^\n]+$/g)||[],blocks=[];
    const add=(type,start,end,extra={})=>blocks.push({id:`md-${blocks.length}`,type,raw:lines.slice(start,end).join(''),...extra});
    let i=0;
    if(/^\uFEFF?---\s*$/.test(lineText(lines[0]||''))){
      const end=lines.findIndex((line,index)=>index>0&&/^(?:---|\.\.\.)\s*$/.test(lineText(line)));
      if(end>0&&/^\s*[\w\u3400-\u9fff][\w\u3400-\u9fff .-]*\s*:/m.test(lines.slice(1,end).join(''))){add('locked',0,end+1,{label:'文档属性',metadata:true});i=end+1;}
    }
    while(i<lines.length){
      const start=i;
      if(isGap(lines[i])){while(i<lines.length&&isGap(lines[i]))i++;add('gap',start,i);continue;}
      const opening=fence(lines[i]);
      if(opening){i++;while(i<lines.length){const closingLine=lineText(lines[i++]),closing=fence(closingLine);if(closing&&closing[1][0]===opening[1][0]&&closing[1].length>=opening[1].length&&!closingLine.slice(closing[0].length).trim())break;}add('locked',start,i,{label:'代码块'});continue;}
      const title=heading(lines[i]);
      if(title){const tokens=inlineTokens(title[2]);add(tokens?'heading':'locked',i,i+1,{level:title[1].length,tokens,label:'标题'});i++;continue;}
      if(rule(lines[i])){add('locked',i,i+1,{label:'分隔线'});i++;continue;}
      const firstList=listLine(lines[i]);
      if(firstList){
        i++;while(i<lines.length&&!isGap(lines[i])&&(listLine(lines[i])||/^[ \t]+\S/.test(lines[i])))i++;
        const items=lines.slice(start,i).map(listLine),ordered=/\d/.test(firstList[1]),tokens=items.map(item=>item&&inlineTokens(item[2]));
        const indent=/^ */.exec(lines[start])[0].length;
        const simple=items.every((item,index)=>item&&/^ */.exec(lines[start+index])[0].length===indent&&/\d/.test(item[1])===ordered&&tokens[index]&&!/^\[[ xX]\]\s/.test(item[2]));
        add(simple?'list':'locked',start,i,{ordered,start:ordered?parseInt(firstList[1],10):1,items:tokens,label:'列表'});continue;
      }
      i++;while(i<lines.length&&!isGap(lines[i])&&!boundary(lines[i]))i++;
      const raw=lines.slice(start,i).join('').replace(/\r?\n$/,''),setext=i-start===2&&/^ {0,3}(?:=+|-+)\s*$/.test(lineText(lines[i-1]));
      const unsupported=/^(?: {4}|\t| {0,3}>|\s*<|\s*\[[^\]]+\]:|\s*\$\$)/m.test(raw)||/^\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}/.test(raw.replace(/\r/g,''));
      const tokens=unsupported?null:inlineTokens(setext?lineText(lines[start]):raw);
      add(tokens?setext?'heading':'paragraph':'locked',start,i,{tokens,...(setext?{level:lineText(lines[i-1]).trim()[0]==='='?1:2}:{}),label:unsupported?'特殊格式':'内容块'});
    }
    if(!blocks.some(block=>block.type!=='gap'))blocks.push({id:'md-empty',type:'paragraph',raw:'',tokens:[]});
    return blocks;
  }
  function escapeText(value){return string(value).replace(/\\/g,'\\\\').replace(/([`*_[\]<>])/g,'\\$1').replace(/^(\s*)([#>+\-]|\d+\.)\s/gm,'$1\\$2 ');}
  function codeSpan(value){const runs=string(value).match(/`+/g)||[],marker='`'.repeat(Math.max(0,...runs.map(run=>run.length))+1),padding=/^`|`$|^ .+ $/.test(value)?' ':'';return `${marker}${padding}${value}${padding}${marker}`;}
  function wrap(marker,value){const match=/^(\s*)([\s\S]*?)(\s*)$/.exec(value);return match[2]?`${match[1]}${marker}${match[2]}${marker}${match[3]}`:value;}
  function serializeInline(node){
    if(node.nodeType===3)return escapeText(node.nodeValue||'');
    if(node.nodeType!==1)return '';
    const tag=node.tagName.toLowerCase(),inside=()=>Array.from(node.childNodes).map(serializeInline).join('');
    if(tag==='br')return '  \n';if(tag==='code'||tag==='font'&&node.getAttribute('face')==='monospace')return codeSpan(node.textContent||'');
    if(tag==='strong'||tag==='b')return wrap('**',inside());if(tag==='em'||tag==='i')return wrap('*',inside());
    if(tag==='a'){const href=safeLink(node.getAttribute('href')),title=node.getAttribute('title');return href?`[${inside()}](${href.replace(/\(/g,'%28').replace(/\)/g,'%29')}${title?' "'+title.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"':''})`:inside();}
    if(tag==='span'){if(/(?:^|[,\s"'])monospace(?:$|[,\s"'])/i.test(node.style?.fontFamily||''))return codeSpan(node.textContent||'');let value=inside();if(/^(bold|[6-9]00)$/.test(node.style?.fontWeight||''))value=wrap('**',value);if(node.style?.fontStyle==='italic')value=wrap('*',value);return value;}
    if(tag==='script'||tag==='style'||tag==='iframe')return '';
    return inside();
  }
  function inlineChildren(node){if(node.childNodes.length===1&&node.firstChild.nodeName==='BR')return '';return Array.from(node.childNodes).map(serializeInline).join('').replace(/  \n$/,'');}
  function serializeNode(node){
    if(node.nodeType===3)return escapeText(node.nodeValue||'');if(node.nodeType!==1)return '';
    const tag=node.tagName.toLowerCase();
    // Chromium can place a generated list inside the current paragraph/heading.
    // Preserve that structure even before its editing engine normalizes the DOM.
    if(!['ul','ol'].includes(tag)&&Array.from(node.children).some(child=>['UL','OL'].includes(child.tagName)))return serializeEditable(node);
    if(/^h[1-6]$/.test(tag))return `${'#'.repeat(Number(tag[1]))} ${inlineChildren(node)}`;
    if(tag==='ul'||tag==='ol'){
      let number=Number(node.getAttribute('start'))||1;
      return Array.from(node.children).filter(child=>child.tagName==='LI').map(li=>{
        const content=Array.from(li.childNodes).filter(child=>!['UL','OL'].includes(child.nodeName)).map(child=>child.nodeName==='P'?inlineChildren(child):serializeInline(child)).join('').replace(/  \n$/,'');
        const nested=Array.from(li.children).filter(child=>['UL','OL'].includes(child.tagName)).map(serializeNode).join('\n');
        return `${tag==='ol'?`${number++}.`:'-'} ${content}${nested?'\n'+nested.split('\n').map(line=>'  '+line).join('\n'):''}`;
      }).join('\n');
    }
    if(tag==='div'&&Array.from(node.children).some(child=>/^(P|DIV|H[1-6]|UL|OL)$/.test(child.tagName)))return serializeEditable(node);
    return inlineChildren(node);
  }
  function serializeEditable(container){
    const blocks=[];let inline='';const flush=()=>{if(inline){blocks.push(inline);inline='';}};
    for(const child of container.childNodes){if(child.nodeType===1&&/^(P|DIV|H[1-6]|UL|OL)$/.test(child.nodeName)){flush();blocks.push(serializeNode(child));}else inline+=serializeInline(child);}
    flush();return blocks.join('\n\n');
  }
  function replaceBlock(block,markdown){const newline=block.newline||(block.raw.includes('\r\n')?'\r\n':'\n'),ending=/\r?\n$/.exec(block.raw)?.[0]||'';return (markdown?block.prefix||'':'')+string(markdown).replace(/\r?\n/g,newline)+ending;}
  function mount(container,options={}){
    const doc=container.ownerDocument,view=doc.defaultView;let blocks=[],active=null,selection=null,disabled=false,destroyed=false;
    const el=(tag,className,value)=>{const item=doc.createElement(tag);if(className)item.className=className;if(value!==undefined)item.textContent=value;return item;};
    const shell=el('section','markdown-editor'),toolbar=el('div','markdown-editor-toolbar'),body=el('div','markdown-editor-body'),status=el('span','markdown-editor-hint','直接点击正文编辑');
    shell.setAttribute('aria-label','可编辑 Markdown 文档');toolbar.setAttribute('role','toolbar');toolbar.setAttribute('aria-label','文档格式');body.setAttribute('data-user-content','');
    const button=(label,action,title=label)=>{const item=el('button','markdown-editor-button',label);item.type='button';item.title=title;item.setAttribute('aria-label',title);item.addEventListener('mousedown',event=>event.preventDefault());item.addEventListener('click',()=>{if(!disabled)action();});toolbar.append(item);return item;};
    const format=el('select','markdown-editor-format');format.setAttribute('aria-label','段落格式');for(const [value,label] of [['p','正文'],['h1','标题 1'],['h2','标题 2'],['h3','标题 3'],['ul','项目列表'],['ol','编号列表']]){const item=el('option','',label);item.value=value;format.append(item);}toolbar.append(format);
    const getValue=()=>blocks.map(block=>block.changed??block.raw).join('');
    const notify=()=>{status.textContent='编辑后保存以写入文档';options.onChange?.(getValue());};
    function sync(block){if(disabled||destroyed)return;const html=block.element.innerHTML;block.changed=html===block.originalHTML?null:replaceBlock(block,serializeEditable(block.element));notify();}
    function rememberSelection(){const current=view?.getSelection?.();if(!current?.rangeCount)return;const selected=blocks.find(block=>!['gap','locked'].includes(block.type)&&block.element.contains(current.anchorNode)&&block.element.contains(current.focusNode));if(selected){active=selected;selection=current.getRangeAt(0).cloneRange();}else if(body.contains(current.anchorNode)){active=selection=null;status.textContent='请在同一段落内选择要设置格式的文字';}}
    function restoreSelection(){if(!active)return false;const saved=selection;active.element.focus({preventScroll:true});if(saved&&active.element.contains(saved.startContainer)&&active.element.contains(saved.endContainer)){const current=view.getSelection();current.removeAllRanges();current.addRange(saved);selection=saved;}return true;}
    function command(name,value){if(!restoreSelection())return;doc.execCommand(name,false,value);sync(active);rememberSelection();}
    button('B',()=>command('bold'),'粗体（⌘B / Ctrl+B）').classList.add('markdown-editor-bold');button('I',()=>command('italic'),'斜体（⌘I / Ctrl+I）').classList.add('markdown-editor-italic');
    button('</>',()=>{if(!restoreSelection())return;const current=view.getSelection(),range=current.rangeCount?current.getRangeAt(0):null;if(!range||range.collapsed){status.textContent='先选中文字，再设置行内代码';return;}doc.execCommand('fontName',false,'monospace');sync(active);rememberSelection();},'行内代码');
    const linkPanel=el('div','markdown-editor-link-panel'),linkInput=el('input');linkInput.type='url';linkInput.placeholder='https://…';linkInput.setAttribute('aria-label','链接地址');linkPanel.hidden=true;
    button('链接',()=>{rememberSelection();if(!selection||selection.collapsed){status.textContent='先选中文字，再添加链接';return;}linkPanel.hidden=false;linkInput.value='';linkInput.focus();});
    button('+ 段落',()=>{const current=getValue(),newline=current.includes('\r\n')?'\r\n':'\n',gap=current.endsWith(newline+newline)?'':current.endsWith(newline)?newline:newline+newline;setValue(current+gap);const last=blocks.at(-1);last.element?.focus();active=last;notify();},'在文档末尾添加段落');
    const linkApply=el('button','markdown-editor-button','应用'),linkCancel=el('button','markdown-editor-button','取消');linkApply.type=linkCancel.type='button';
    const applyLink=()=>{const href=safeLink(linkInput.value);if(!href){status.textContent='请输入有效的网页、邮件或相对链接';return;}linkPanel.hidden=true;command('createLink',href);};
    linkApply.addEventListener('click',applyLink);linkCancel.addEventListener('click',()=>{linkPanel.hidden=true;restoreSelection();});linkInput.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();event.stopPropagation();applyLink();}if(event.key==='Escape'){event.preventDefault();event.stopPropagation();linkPanel.hidden=true;restoreSelection();}});linkPanel.append(linkInput,linkApply,linkCancel);
    format.addEventListener('mousedown',rememberSelection);format.addEventListener('change',()=>{const value=format.value;if(value==='ul'||value==='ol'){command('formatBlock','p');command(value==='ul'?'insertUnorderedList':'insertOrderedList');}else command('formatBlock',value);});
    toolbar.append(status);shell.append(toolbar,linkPanel,body);container.replaceChildren(shell);
    function renderTokens(tokens,target){for(const token of tokens||[]){if(token.type==='text'){target.append(doc.createTextNode(token.value));continue;}const item=el(token.type);if(token.type==='code')item.textContent=token.value;else{if(token.type==='a'){item.setAttribute('href',token.href);if(token.title)item.setAttribute('title',token.title);}renderTokens(token.children,item);}target.append(item);}}
    function requestSource(block){let start=0;for(const item of blocks){if(item===block)break;start+=(item.changed??item.raw).length;}options.onRequestSource?.({start,end:start+(block.changed??block.raw).length,type:block.type,value:getValue()});}
    function selectionSource(){
      const current=view?.getSelection?.(),live=current?.rangeCount?current.getRangeAt(0):null;
      const range=live&&body.contains(live.startContainer)&&body.contains(live.endContainer)?live:selection;
      if(!range||range.collapsed||!body.contains(range.startContainer)||!body.contains(range.endContainer))return null;
      const first=blocks.find(block=>block.element?.contains(range.startContainer)),last=blocks.find(block=>block.element?.contains(range.endContainer));
      if(!first||!last)return null;
      const start=blocks.slice(0,blocks.indexOf(first)).reduce((sum,block)=>sum+(block.changed??block.raw).length,0);
      const end=blocks.slice(0,blocks.indexOf(last)+1).reduce((sum,block)=>sum+(block.changed??block.raw).length,0);
      const raw=first.changed??first.raw,plain=raw.replace(/\r?\n$/,'').replace(/\r\n?/g,'\n');
      // A literal paragraph gives a provable one-to-one mapping. Formatted,
      // escaped, list and multi-block selections explicitly hand off to source;
      // looking up selected text would target the wrong duplicate occurrence.
      if(first!==last||first.type!=='paragraph'||first.element.textContent!==plain||first.element.querySelector('strong,b,em,i,a,code,br,ul,ol'))return {exact:false,start,end,value:getValue(),reason:'当前富文本选区含格式或跨段落。已定位对应源码，请确认或重新选择准确范围，再点击 AI 改写。'};
      const prefix=doc.createRange();prefix.selectNodeContents(first.element);prefix.setEnd(range.startContainer,range.startOffset);
      const through=doc.createRange();through.selectNodeContents(first.element);through.setEnd(range.endContainer,range.endOffset);
      const offset=shown=>{let i=0,count=0;while(i<raw.length&&count<shown){i+=raw[i]==='\r'&&raw[i+1]==='\n'?2:1;count++;}return i;};
      return {exact:true,start:start+offset(prefix.toString().length),end:start+offset(through.toString().length),value:getValue()};
    }
    function setValue(value){
      blocks=parse(value);active=selection=null;body.replaceChildren();linkPanel.hidden=true;
      if(['gap','locked'].includes(blocks.at(-1)?.type)){const current=string(value),newline=current.includes('\r\n')?'\r\n':'\n';blocks.push({id:'md-append',type:'paragraph',raw:'',tokens:[],newline,prefix:current.endsWith(newline+newline)?'':current.endsWith(newline)?newline:newline+newline});}
      for(const block of blocks){
        if(block.type==='gap')continue;
        const item=el('div',`markdown-editor-block markdown-editor-${block.type}`);block.element=item;item.dataset.markdownBlock=block.id;
        if(block.type==='locked'){
          const label=el('div','markdown-editor-locked-label',`${block.label} · 保留原始格式`),source=el('button','markdown-editor-source','编辑源码');source.type='button';source.disabled=disabled;source.addEventListener('click',()=>requestSource(block));label.append(source);item.append(label);
          if(block.metadata){const details=el('details','markdown-editor-metadata'),summary=el('summary','','查看文档属性');details.append(summary,el('pre','',block.raw));item.append(details);}
          else{const preview=el('div','markdown-editor-locked-preview');if(typeof options.renderMarkdown==='function')preview.innerHTML=options.renderMarkdown(block.raw);else preview.append(el('pre','',block.raw));item.append(preview);}
          if(!options.onRequestSource)source.hidden=true;
        }else{
          item.contentEditable=String(!disabled);item.spellcheck=false;item.setAttribute('role','textbox');item.setAttribute('aria-multiline','true');item.setAttribute('aria-label',block.type==='heading'?`标题 ${block.level}`:block.type==='list'?'列表':'正文段落');item.dataset.placeholder='开始输入，写下你的想法…';
          let content;if(block.type==='list'){content=el(block.ordered?'ol':'ul');if(block.ordered)content.setAttribute('start',String(block.start));for(const tokens of block.items){const li=el('li');renderTokens(tokens,li);content.append(li);}}
          else{content=el(block.type==='heading'?`h${block.level}`:'p');renderTokens(block.tokens,content);if(!content.childNodes.length)content.append(el('br'));}item.append(content);block.originalHTML=item.innerHTML;
          item.addEventListener('focus',()=>{active=block;selection=null;format.value=block.type==='heading'?`h${Math.min(block.level,3)}`:block.type==='list'?block.ordered?'ol':'ul':'p';});item.addEventListener('keyup',rememberSelection);item.addEventListener('mouseup',rememberSelection);item.addEventListener('input',()=>sync(block));
          item.addEventListener('click',event=>{if(event.target.closest?.('a'))event.preventDefault();});
          item.addEventListener('paste',event=>{event.preventDefault();if(!disabled){doc.execCommand('insertText',false,event.clipboardData?.getData('text/plain')||'');sync(block);}});
          item.addEventListener('drop',event=>event.preventDefault());
          item.addEventListener('keydown',event=>{if(event.isComposing)return;if((event.metaKey||event.ctrlKey)&&['b','i'].includes(event.key.toLowerCase())){event.preventDefault();active=block;rememberSelection();command(event.key.toLowerCase()==='b'?'bold':'italic');}});
        }
        body.append(item);
      }
    }
    function setDisabled(value){disabled=!!value;shell.setAttribute('aria-disabled',String(disabled));for(const item of shell.querySelectorAll('button,input,select'))item.disabled=disabled;for(const block of blocks)if(block.type!=='gap'&&block.type!=='locked')block.element.contentEditable=String(!disabled);}
    setValue(options.value);setDisabled(options.disabled);
    return {getValue,setValue,setDisabled,selectionSource,focus(){const target=active?.element||blocks.find(block=>!['gap','locked'].includes(block.type))?.element;target?.focus();},destroy(){destroyed=true;active=selection=null;shell.remove();}};
  }
  return {mount,parse,inlineTokens,escapeText,codeSpan,safeLink,replaceBlock,serializeEditable};
});
