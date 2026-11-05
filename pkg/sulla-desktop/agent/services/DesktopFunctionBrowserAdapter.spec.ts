// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { DesktopFunctionBrowserAdapter } from './DesktopFunctionBrowserAdapter';
class Event { addListener() {} removeListener() {} }
class ChromeHarness {
  removed: string[]=[]; result: Promise<any> = Promise.resolve([{result:{result:'ok'}}]);
  tabs={create:async()=>({id:'tab'}),get:async()=>({id:'tab',url:'https://example.com',status:'complete'}),remove:async(id:string)=>{this.removed.push(id)}};
  scripting={executeScript:async()=>this.result}; webNavigation={onBeforeNavigate:new Event(),onCommitted:new Event()};
}
describe('DesktopFunctionBrowserAdapter',()=>{
  it('terminates the tab when evaluation exceeds its deadline',async()=>{ // risk: Electron denial of service
    const chrome=new ChromeHarness(); chrome.result=new Promise(()=>{}); const adapter=new DesktopFunctionBrowserAdapter(chrome as any,1,1024); await adapter.open('a','https://example.com',async()=>{}); await expect(adapter.evaluate('a','1')).rejects.toThrow('timed out'); expect(chrome.removed).toEqual(['tab']);
  });
  it('rejects an oversized result before it reaches the HTTP writer',async()=>{ // risk: Electron memory exhaustion
    const chrome=new ChromeHarness(); chrome.result=Promise.resolve([{result:{result:'x'.repeat(20)}}]); const adapter=new DesktopFunctionBrowserAdapter(chrome as any,100,10); await adapter.open('a','https://example.com',async()=>{}); await expect(adapter.evaluate('a','1')).rejects.toThrow('size limit');
  });
});
