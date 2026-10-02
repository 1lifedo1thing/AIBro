import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=dirname(fileURLToPath(import.meta.url));
const publicDir=resolve(process.env.FILM_PUBLIC_DIR||resolve(root,'../../dist'));
const manifest=JSON.parse(readFileSync(resolve(root,'asset-manifest.json')));
const missing=[];
for(const a of manifest.assets){
 try{const bytes=readFileSync(resolve(publicDir,a.path));if(bytes.length!==a.bytes||createHash('sha256').update(bytes).digest('hex')!==a.sha256)missing.push(a.path+' (hash mismatch)');}
 catch{missing.push(a.path+' (missing)');}
}
if(missing.length)throw Error('Extract the matching motion84-assets-20261002.zip into launch/dist first:\n'+missing.join('\n'));
console.log('All '+manifest.assets.length+' film assets match their SHA-256 manifest.');
