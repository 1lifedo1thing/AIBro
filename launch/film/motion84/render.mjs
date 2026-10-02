import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const film=resolve(root,'..'),publicDir=resolve(process.env.FILM_PUBLIC_DIR||resolve(root,'../../dist'));
const output=resolve(root,'output');mkdirSync(output,{recursive:true});
execFileSync(process.execPath,[resolve(root,'check-assets.mjs')],{stdio:'inherit'});
const cli=resolve(film,'node_modules/@remotion/cli/remotion-cli.js');
const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg';
const chrome=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const languages=(process.env.RENDER_LANGS||'zh,en').split(',');
for(const lang of languages){
 if(!['zh','en'].includes(lang))throw Error('RENDER_LANGS must be zh, en, or zh,en');
 const parts=[];
 for(let part=0;part<6;part++){
  const file=resolve(output,`${lang}-${part}.mp4`);parts.push(file);
  const args=[cli,'render',resolve(root,'src/motion-full-index.jsx'),'AIBroRefined-'+lang,file,'--frames='+part*840+'-'+(part*840+839),'--public-dir='+publicDir,'--image-format=png','--codec=h264','--crf=18','--pixel-format=yuv420p','--x264-preset=medium','--concurrency=1'];
  if(existsSync(chrome))args.push('--browser-executable='+chrome);
  execFileSync(process.execPath,args,{cwd:film,stdio:'inherit'});
 }
 const list=resolve(output,lang+'-concat.txt');writeFileSync(list,parts.map(f=>`file '${f.replaceAll("'","'\\''")}'\n`).join(''));
 execFileSync(ffmpeg,['-y','-f','concat','-safe','0','-i',list,'-i',resolve(publicDir,'assets/film/motion84/music-a.m4a'),'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','copy','-t','84','-movflags','+faststart',resolve(output,'aibro-motion-'+lang+'.mp4')],{stdio:'inherit'});
}
