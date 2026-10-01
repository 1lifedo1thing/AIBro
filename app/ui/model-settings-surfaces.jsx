import React,{useLayoutEffect,useRef} from 'react';
import {Card,Heading,Text,Badge,Label,TextInput,Select,Button} from './halaska-kit.jsx';
import {Server,KeyRound,FlaskConical,Layers,Trash2} from 'lucide-react';
const t=(zh,en)=>/^en(?:-|$)/i.test(document.documentElement.lang)?en:zh;

// Slots deliberately contain DOM owned by app.js. React owns only the shell.
// Secret fields are neither read here nor copied into props/state/decorations.
function HostSlot({id,attach,className='',label}){
 const ref=useRef(null);
 useLayoutEffect(()=>{const release=attach(id,ref.current);const input=ref.current?.querySelector('input,select');if(input&&label)input.setAttribute('aria-label',label);return release;},[attach,id]);
 useLayoutEffect(()=>{const input=ref.current?.querySelector('input,select');if(input&&label)input.setAttribute('aria-label',label);},[label]);
 return <div ref={ref} className={`model-host-slot ${className}`} data-model-slot={id}/>;
}
function RetainedField({id,label,description,controls,attach,select=false,secret=false}){
 const state=controls[id]||{},ref=useRef(null);
 useLayoutEffect(()=>{const labelNode=ref.current?.querySelector('.model-setting-label label');if(labelNode)labelNode.htmlFor=id;const presentation=ref.current?.querySelector('.model-control-presentation');for(const input of presentation?.querySelectorAll('input,button,select')||[])input.tabIndex=-1;});
 return <div className="model-setting-field" ref={ref}>
  <div className="model-setting-label"><Label>{label}</Label></div>
  <div className={`model-retained-control${select?' model-retained-select':''}`} data-disabled={state.disabled||undefined}>
   <div className="model-control-presentation" aria-hidden="true" inert={true}>{select?<Select value={state.value} options={state.options||[]} disabled={state.disabled} size="md"/>:<TextInput value="" type={secret?'password':'text'} disabled={state.disabled} size="md"/>}</div>
   <HostSlot id={id} attach={attach} label={label} className="model-control-native"/>
  </div>
  {description&&<Text as="p" size="xs" secondary style={{margin:'6px 0 0',lineHeight:1.65}}>{description}</Text>}
 </div>;
}
function RetainedAction({id,controls,attach,variant='outline',icon}){
 const state=controls[id]||{};
 return <div className="model-retained-action" hidden={state.hidden} data-disabled={state.disabled||undefined}>
  <div className="model-action-presentation" aria-hidden="true" inert={true}><Button size="sm" variant={variant} disabled={state.disabled} icon={icon}>{state.label||t('操作','Action')}</Button></div>
  <HostSlot id={id} attach={attach} className="model-action-native"/>
 </div>;
}
export function ModelSettingsSurface({controls={},attach}){
 const props={controls,attach};
 return <div className="model-settings-kit">
  <Card padding={0} style={{background:'var(--panel)',border:'1px solid var(--line)',borderRadius:18,boxShadow:'none'}}>
   <div className="model-section-heading"><span className="model-section-icon"><Server size={18} aria-hidden="true"/></span><div><Heading level={3} style={{fontSize:17,margin:0}}>{t('API 连接','API connection')}</Heading><Text as="p" size="xs" secondary style={{margin:'5px 0 0',lineHeight:1.6}}>{t('填写服务地址和凭据，再验证当前连接。','Enter the service address and credentials, then test this connection.')}</Text></div></div>
   <div className="model-section-body"><RetainedField {...props} id="apiBase" label={t('API 地址','API address')}/><RetainedField {...props} id="apiProtocol" label={t('接口协议','API protocol')} select/>
    <div className="model-key-field"><RetainedField {...props} id="apiKey" label="API Key" secret/><div className="model-credential-notice"><KeyRound size={13} aria-hidden="true"/><HostSlot id="apiCredentialStatus" attach={attach}/></div><div className="model-key-actions"><HostSlot id="apiCredentialUnlock" attach={attach}/><RetainedAction {...props} id="clearApiKey" variant="ghost" icon={<Trash2 size={13} aria-hidden="true"/>}/></div></div>
    <div className="model-connection-test"><RetainedAction {...props} id="testApi" icon={<FlaskConical size={14} aria-hidden="true"/>}/><HostSlot id="apiStatus" attach={attach} className="model-connection-status"/></div>
    <Text as="p" size="xs" secondary style={{margin:0,lineHeight:1.7}}>{t('测试只读取模型列表，不验证生成能力，也不会保存输入。地址、协议、Key 和默认模型需要点击本分区上方“保存模型与权限”后保留。','Testing only reads the model list; it does not verify generation or save your input. Use Save models & permissions above to keep the address, protocol, key and default model.')}</Text>
   </div>
  </Card>
  <Card padding={0} style={{background:'var(--panel)',border:'1px solid var(--line)',borderRadius:18,boxShadow:'none'}}>
   <div className="model-section-heading"><span className="model-section-icon"><Layers size={18} aria-hidden="true"/></span><div><Heading level={3} style={{fontSize:17,margin:0}}>{t('模型默认值','Model defaults')}</Heading><Text as="p" size="xs" secondary style={{margin:'5px 0 0',lineHeight:1.6}}>{t('先设置全局模型，再按工作区覆盖。','Set a global model, then override it by workspace.')}</Text></div></div>
   <div className="model-section-body"><RetainedField {...props} id="model" label={t('默认模型','Default model')} description={t('可以输入模型名称，也可以从测试返回的列表中选择。','Enter a model name or choose from the list returned by the connection test.')}/><HostSlot id="apiModelOptions" attach={attach}/>
    <div className="model-workspace-heading"><Heading level={4} style={{fontSize:13,margin:0}}>{t('工作区模型','Workspace models')}</Heading><Badge>{t('修改后立即生效','Applies immediately')}</Badge></div>
    <div className="model-workspace-fields">{[['daily',t('日常','Daily')],['course',t('课程','Courses')],['research',t('科研','Research')]].map(([key,label])=><RetainedField key={key} {...props} id={'workspaceModel-'+key} label={label}/>)}</div>
    <Text as="p" size="xs" secondary style={{margin:0,lineHeight:1.7}}>{t('工作区留空时跟随全局默认。对话设定 → 项目设定 → 工作区设定 → 全局默认；修改只影响新的执行。','Blank workspaces use the global default. Conversation → project → workspace → global default; changes affect new runs only.')}</Text>
   </div>
  </Card>
 </div>;
}
