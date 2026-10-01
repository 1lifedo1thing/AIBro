import {spawnSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.dirname(fileURLToPath(import.meta.url));
const output=path.resolve(root,'../dist/assets/film');
mkdirSync(output,{recursive:true});
const browser=process.env.AIBRO_RENDER_BROWSER;
const common=['--public-dir=../dist','--concurrency=2',...(browser?['--browser-executable='+browser]:[])];
function run(args){const r=spawnSync(path.resolve(root,'node_modules/.bin/remotion'),args,{cwd:root,stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);}
for(const [lang,id] of [['zh','AIBroZH'],['en','AIBroEN']]){
 run(['render','src/index.jsx',id,path.join(output,'promo-'+lang+'.mp4'),'--codec=h264','--crf=18','--audio-codec=aac',...common]);
 run(['still','src/index.jsx',id,path.join(output,'poster-'+lang+'.jpg'),'--frame=235','--image-format=jpeg','--props={"withAudio":false}',...common]);
}
