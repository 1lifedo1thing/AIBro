(()=>{
 const rpc=body=>window.webkit.messageHandlers.desktop.postMessage(body);
 const keys=new Set(['workstation-api-base','workstation-api-model','workstation-openai-model','workstation-provider','aibro-embedding-settings-v1','ai-bro-language','workstation-ui']);
 for(const [key,value] of Object.entries(window.__nativePreferences||{}))if(keys.has(key))localStorage.setItem(key,value);
 delete window.__nativePreferences;
 const originalSet=Storage.prototype.setItem,originalRemove=Storage.prototype.removeItem;
 Storage.prototype.setItem=function(key,value){originalSet.call(this,key,value);if(this===localStorage&&keys.has(key))rpc({command:'preferences',key,value:String(value)}).catch(()=>{});};
 Storage.prototype.removeItem=function(key){originalRemove.call(this,key);if(this===localStorage&&keys.has(key))rpc({command:'preferences',key}).catch(()=>{});};
 const credentials=channel=>({storageBackend:'encrypted-file',...Object.fromEntries(['status','read','unlock','save','authorizeSave','remove','authorizeRemove'].map(action=>[action,async options=>{try{return await rpc({command:'credentials',channel,action,options:options||{}});}catch(error){const match=String(error?.message||error).match(/^\[((?:KEYCHAIN|CREDENTIAL)_[A-Z_]+)\]\s*(.*)$/s);if(!match)throw error;const failure=new Error(match[2]);failure.code=match[1];throw failure;}}]))});
 window.workstationDesktop={isDesktop:true,platform:'darwin',agendaProposal:proposal=>rpc({command:'agenda-proposal',proposal}),agendaDraft:id=>rpc({command:'agenda-draft',id}),agendaOpen:id=>rpc({command:'agenda-open',id}),agendaRelated:()=>rpc({command:'agenda-related'}),agendaNotifications:enable=>rpc({command:'agenda-notifications',enable:enable===true}),apiCredentials:credentials('api'),embeddingCredentials:credentials('embedding'),setLanguage:value=>rpc({command:'language',value}),setAppearance:value=>rpc({command:'appearance',value}),openAuthURL:url=>rpc({command:'auth',url})};
 window.workstationDesktop.navigateWorkspace=destination=>rpc({command:'navigate-workspace',destination});
 window.workstationDesktop.nativeWorkspacePersistence=true;
 window.workstationDesktop.browser={request:request=>rpc({command:'browser',request})};
 window.workstationDesktop.vectorIndex={load:profile=>rpc({command:'vector-index',action:'load',profile}),write:(profile,puts=[],removes=[])=>rpc({command:'vector-index',action:'write',profile,puts,removes})};
})();
