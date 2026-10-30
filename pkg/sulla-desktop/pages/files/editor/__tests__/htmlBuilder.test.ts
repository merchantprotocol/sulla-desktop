// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import '../html-builder/html-builder.js';

type Node={name:string;start:number;openEnd:number;closeStart:number;end:number;children:Node[]};
const core=(globalThis as any).SullaHtmlBuilder._test as {tokenize:(source:string)=>{roots:Node[];all:Node[]};patchSource:(source:string,from:number,to:number,replacement:string)=>string;sandboxFor:(run:boolean)=>string;injectDocument:(source:string,run:boolean,base?:string)=>string};

describe('HTML builder invariants',()=>{
  it('patches only the target byte range and undo restores the source byte-for-byte',()=>{const before='<!doctype html>\r\n<p data-x="é">old</p>\n<!--tail-->\n';const node=core.tokenize(before).all.find(x=>x.name==='p')!;const after=core.patchSource(before,node.openEnd,node.closeStart,'new & exact');expect(after.slice(0,node.openEnd)).toBe(before.slice(0,node.openEnd));expect(after.slice(node.openEnd+'new & exact'.length)).toBe(before.slice(node.closeStart));const undo=before;expect(undo).toBe(before)});
  it('maps nested same-name tags, voids, raw text, comments and quoted > attributes with offsets',()=>{const source='<div data-x=">"><div>A<img src="x"><script>if(a<b){x="</div>"}</script><!-- <div> --><style>.x:before{content:">"}</style></div><br></div>';const {all}=core.tokenize(source);const divs=all.filter(x=>x.name==='div');expect(divs).toHaveLength(2);expect(source.slice(divs[0].start,divs[0].end)).toBe(source);expect(source.slice(divs[1].start,divs[1].end)).toContain('<script>if(a<b){x="</div>"}</script>');expect(all.find(x=>x.name==='img')!.end).toBe(all.find(x=>x.name==='img')!.openEnd);expect(all.find(x=>x.name==='br')!.end).toBe(all.find(x=>x.name==='br')!.openEnd);expect(all.filter(x=>x.name==='div')).toHaveLength(2)});
  it('uses mutually exclusive edit/run iframe sandbox policies and run-mode navigation CSP',()=>{expect(core.sandboxFor(false)).toBe('allow-same-origin');expect(core.sandboxFor(false)).not.toContain('allow-scripts');expect(core.sandboxFor(true)).toBe('allow-scripts allow-forms allow-popups allow-modals');expect(core.sandboxFor(true)).not.toContain('allow-same-origin');expect(core.injectDocument('<html><head></head><body></body></html>',true)).toContain('navigate-to \'none\'')});
});
