// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { DesktopFunctionBrowserAdapter } from './DesktopFunctionBrowserAdapter';
class Event {
  listeners: Array<(details:any)=>void>=[];
  addListener(listener:(details:any)=>void) { this.listeners.push(listener) }
  removeListener(listener:(details:any)=>void) { this.listeners=this.listeners.filter(item=>item!==listener) }
  emit(details:any) { for(const listener of this.listeners) listener(details) }
}
class ChromeHarness {
  removed: string[]=[]; result: Promise<any> = Promise.resolve([{result:{result:'ok'}}]);
  currentUrl='https://example.com'; createProperties:any;
  tabs={create:async(props:any)=>{this.createProperties=props; return {id:'tab'}},get:async()=>({id:'tab',url:this.currentUrl,status:'complete'}),remove:async(id:string)=>{this.removed.push(id)}};
  scripting={executeScript:async()=>this.result}; webNavigation={onBeforeNavigate:new Event(),onCommitted:new Event()};
}
describe('DesktopFunctionBrowserAdapter',()=>{
  it('terminates the tab when evaluation exceeds its deadline',async()=>{ // risk: Electron denial of service
    const chrome=new ChromeHarness(); chrome.result=new Promise(()=>{}); const adapter=new DesktopFunctionBrowserAdapter(chrome as any,1,1024); await adapter.open('a','https://example.com',async()=>{}); await expect(adapter.evaluate('a','1')).rejects.toThrow('timed out'); expect(chrome.removed).toEqual(['tab']);
  });
  it('rejects an oversized result before it reaches the HTTP writer',async()=>{ // risk: Electron memory exhaustion
    const chrome=new ChromeHarness(); chrome.result=Promise.resolve([{result:{result:'x'.repeat(20)}}]); const adapter=new DesktopFunctionBrowserAdapter(chrome as any,100,10); await adapter.open('a','https://example.com',async()=>{}); await expect(adapter.evaluate('a','1')).rejects.toThrow('size limit');
  });
  it('keeps navigation guarded and closes before eval after a private redirect',async()=>{ // risk: SSRF
    const chrome=new ChromeHarness(); const adapter=new DesktopFunctionBrowserAdapter(chrome as any);
    const validate=async(url:string)=>{if(url.includes('127.0.0.1')) throw new Error('unsafe-network-target')};
    await adapter.open('a','https://example.com',validate);
    chrome.currentUrl='http://127.0.0.1/private';
    await expect(adapter.evaluate('a','1')).rejects.toThrow('unsafe-network-target');
    expect(chrome.removed).toEqual(['tab']);
  });
  it('passes a blocking request guard before initial load and subresources',async()=>{ // risk: SSRF
    const chrome=new ChromeHarness(); const adapter=new DesktopFunctionBrowserAdapter(chrome as any);
    const validate=async(url:string)=>{if(url.includes('127.0.0.1')) throw new Error('unsafe-network-target')};
    await adapter.open('a','https://example.com',validate);
    await expect(chrome.createProperties.requestGuard('http://127.0.0.1/secret')).rejects.toThrow('unsafe-network-target');
    expect(chrome.createProperties.denyPopups).toBe(true);
  });
  it('retains the navigation listener until close',async()=>{ // risk: SSRF
    const chrome=new ChromeHarness(); const adapter=new DesktopFunctionBrowserAdapter(chrome as any);
    await adapter.open('a','https://example.com',async(url:string)=>{if(url.includes('127.0.0.1')) throw new Error('unsafe-network-target')});
    chrome.webNavigation.onCommitted.emit({tabId:'tab',url:'http://127.0.0.1'});
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(chrome.removed).toEqual(['tab']);
  });
});
