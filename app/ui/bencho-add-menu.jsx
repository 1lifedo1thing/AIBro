/*!
 * AI Bro adaptation of Bencho Create (Code pane block liq-create).
 * MIT License
 * 
 * Copyright (c) 2026 Lorenzo Cabra
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import React from 'react';
import { motion } from 'framer-motion';
import { FilePlus2, FolderOpen, Link2, Paperclip, Plus } from 'lucide-react';
// Bencho's exact Create shape spring: a 0.5 mass, 420/30 critically damped
// spread. Keep text off the shape layer, as in the original component.
const LIQUID = { type: 'spring', stiffness: 220, damping: 14, mass: .5 };
const LIQUID_STILL = { ...LIQUID, stiffness: 420, damping: 30 };
const iconFor = id => /reference|cite|workspace/.test(id)?Link2:/local|project|folder/.test(id)?FolderOpen:/attach|file|upload/.test(id)?Paperclip:/note|document/.test(id)?FilePlus2:Plus;
export function BenchoAddMenu({items=[],label,busy='',error='',geometry,reducedMotion=false,onSelect}){
 const Shape=reducedMotion?'div':motion.div,Row=reducedMotion?'div':motion.div;
 const g=geometry||{width:286,maxHeight:200,from:{left:0,top:0,width:32,height:32}},start=g.from;
 return <div className="bencho-add-menu crt-stage" data-open="true" data-reduced-motion={reducedMotion||undefined} style={{'--crt-r':'20px','--crt-row-r':'12px'}}>
  <div className="crt-blobs" aria-hidden="true"><Shape className="crt-body" {...(reducedMotion?{style:{left:0,top:0,width:g.width,height:g.maxHeight,borderRadius:20,opacity:1}}:{initial:{left:start.left,top:start.top,width:start.width,height:start.height,borderRadius:16,opacity:.8},animate:{left:0,top:0,width:g.width,height:g.maxHeight,borderRadius:20,opacity:1},transition:LIQUID_STILL})}/></div>
  <div className="crt-panel"><div className="crt-menu" role="menu" aria-label={label} aria-busy={!!busy} tabIndex={-1}>
   {items.map((item,i)=>{const Icon=iconFor(item.id);return <Row role="none" className="crt-item" key={item.id} {...(reducedMotion?{}:{initial:{opacity:0,y:4},animate:{opacity:1,y:0},transition:{duration:.16,delay:.03+i*.022,ease:[.22,1,.36,1]}})}><button type="button" role="menuitem" data-add-action={item.id} disabled={item.disabled||!!busy} aria-busy={busy===item.id||undefined} onClick={()=>onSelect(item.id)}><Icon size={17} strokeWidth={1.8} aria-hidden="true"/><span className="crt-item-copy"><span className="crt-item-label">{item.label}</span>{item.description&&<span className="crt-item-description">{item.description}</span>}</span>{busy===item.id&&<span className="crt-pending" aria-hidden="true">…</span>}</button></Row>;})}
  </div>{error&&<p className="crt-error" role="alert">{error}</p>}</div>
 </div>;
}
