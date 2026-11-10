// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { BrowserUrlPolicy, type BrowserDnsResolver } from './BrowserUrlPolicy';
import { FunctionBrowserCapabilityService, FunctionBrowserOpenFailedError, type FunctionBrowserAdapter } from './FunctionBrowserCapabilityService';
class Resolver implements BrowserDnsResolver { constructor(private readonly values: Record<string, string[]> = {}) {} async lookup(host: string): Promise<Array<{address:string}>> { return (this.values[host] ?? ['93.184.216.34']).map(address => ({ address })) } }
class RecordingBrowser implements FunctionBrowserAdapter {
  readonly openTabs = new Set<string>(); closeFailures = 0; redirect: string | null = null; openGate: Promise<void> | null = null; failOpenAfterCreate = false;
  async open(assetId: string, _url: string, validate: (url:string)=>Promise<void>): Promise<void> { this.openTabs.add(assetId); if (this.openGate) await this.openGate; if (this.failOpenAfterCreate) throw new FunctionBrowserOpenFailedError(assetId, new Error('open failed')); if (this.redirect) await validate(this.redirect) }
  async evaluate(_assetId: string, code: string): Promise<unknown> { return { code } }
  async close(assetId: string): Promise<void> { if (this.closeFailures-- > 0) throw new Error('transient'); this.openTabs.delete(assetId) }
}
class Harness {
  readonly browser = new RecordingBrowser(); now = 1_000; tokenNumber = 0; timers: Array<()=>void> = [];
  readonly service = new FunctionBrowserCapabilityService(this.browser, () => this.now, () => `token-${++this.tokenNumber}`, new BrowserUrlPolicy(new Resolver()), callback => { this.timers.push(callback); return this.timers.length as any }, () => undefined);
}
describe('FunctionBrowserCapabilityService', () => {
  it('refuses absent permission and unsupported URL schemes', async() => { // risk: permission/SSRF
    const h = new Harness(); expect(h.service.mintForManifest('x',{spec:{permissions:{}}})).toBeNull(); const {token}=h.service.mint('x',{enabled:true,allowedOrigins:[]});
    for (const url of ['file:///etc/passwd','chrome://settings','data:text/plain,x','javascript:alert(1)']) await expect(h.service.open(token,url)).rejects.toMatchObject({outcome:'invalid-url'});
  });
  it('rejects local, private, and DNS-to-private targets even without an origin allowlist', async() => { // risk: SSRF
    const policy = new BrowserUrlPolicy(new Resolver({'private.example':['10.1.2.3']}));
    for (const url of ['http://localhost','http://127.0.0.1','http://[::1]','http://[::ffff:127.0.0.1]','http://[fc00::1]','http://[fe80::1]','http://10.0.0.1','http://172.16.0.1','http://192.168.0.1','http://169.254.1.1','http://100.64.0.1','http://private.example']) await expect(policy.validate(url)).rejects.toThrow('unsafe-network-target');
  });
  it('uses CIDR math to reject every required IPv4 and IPv6 special-use range', async() => { // risk: SSRF range bypass
    const policy = new BrowserUrlPolicy(new Resolver());
    const ranges: Array<[string, string]> = [
      ['0.1.2.3','1.1.1.1'], ['10.0.0.1','11.0.0.1'], ['100.64.0.1','100.128.0.1'], ['127.0.0.1','128.0.0.1'],
      ['169.254.1.1','169.253.1.1'], ['172.16.0.1','172.32.0.1'], ['192.0.0.1','192.0.1.1'], ['192.0.2.1','192.0.3.1'],
      ['192.88.99.1','192.88.100.1'], ['192.168.0.1','192.169.0.1'], ['198.18.0.1','198.20.0.1'],
      ['198.51.100.1','198.51.101.1'], ['203.0.113.1','203.0.114.1'], ['224.0.0.1','223.255.255.254'],
      ['240.0.0.1','223.255.255.254'], ['255.255.255.255','223.255.255.254'],
      ['::','2606:4700:4700::1111'], ['::1','2606:4700:4700::1111'], ['::192.0.2.1','2606:4700:4700::1111'],
      ['::ffff:8.8.8.8','2606:4700:4700::1111'], ['64:ff9b::808:808','64:ff9a:ffff::1'],
      ['64:ff9b:1::1','64:ff9c::1'], ['100::1','101::1'], ['2001::1','2000:ffff::1'],
      ['2001:db8::1','2001:db7::1'], ['2002::1','2003::1'], ['fc00::1','fbff::1'],
      ['fe80::1','fe7f::1'], ['fec0::1','2606:4700:4700::1111'], ['ff00::1','2606:4700:4700::1111'],
    ];
    for (const [inside, outside] of ranges) {
      const insideUrl = inside.includes(':') ? `http://[${ inside }]` : `http://${ inside }`;
      await expect(policy.validate(insideUrl)).rejects.toThrow('unsafe-network-target');
      const outsideUrl = outside.includes(':') ? `https://[${ outside }]` : `https://${ outside }`;
      try { await expect(policy.validate(outsideUrl)).resolves.toBeInstanceOf(URL) } catch { throw new Error(`${ inside } CIDR unexpectedly included ${ outside }`) }
    }
  });
  it('rejects an allowed public origin redirecting to another or private origin', async() => { // risk: redirect allowlist bypass
    const h=new Harness(); const {token}=h.service.mint('x',{enabled:true,allowedOrigins:['https://example.com']}); h.browser.redirect='https://other.example/'; await expect(h.service.open(token,'https://example.com')).rejects.toMatchObject({outcome:'origin-not-allowed'});
    h.browser.redirect='http://127.0.0.1'; await expect(h.service.open(token,'https://example.com')).rejects.toMatchObject({outcome:'origin-not-allowed'});
  });
  it('invalidates an open racing teardown and closes the late-created tab', async() => { // risk: orphan privileged tab
    const h=new Harness(); let release!:()=>void; h.browser.openGate=new Promise<void>(r=>{release=r}); const {token}=h.service.mint('x',{enabled:true,allowedOrigins:[]}); const opening=h.service.open(token,'https://example.com'); await Promise.resolve(); const invalidating=h.service.invalidate(token); release(); await invalidating; await expect(opening).rejects.toMatchObject({outcome:'expired'}); expect(h.browser.openTabs.size).toBe(0);
  });
  it('passively expires and closes tabs without another broker call', async() => { // risk: leaked browser resources
    const h=new Harness(); const {token}=h.service.mint('x',{enabled:true,allowedOrigins:[]},10); await h.service.open(token,'https://example.com'); expect(h.timers).not.toHaveLength(0); h.timers[0](); await Promise.resolve(); expect(h.browser.openTabs.size).toBe(0); await expect(h.service.evaluate(token,'x','1')).rejects.toMatchObject({outcome:'unknown-token'});
  });
  it('retains a failed close handle so invalidation retries cleanup', async() => { // risk: leaked browser resources
    const h=new Harness(); const {token}=h.service.mint('x',{enabled:true,allowedOrigins:[]}); const {tabId}=await h.service.open(token,'https://example.com'); h.browser.closeFailures=1; await expect(h.service.close(token,tabId)).rejects.toThrow('transient'); await h.service.invalidate(token); expect(h.browser.openTabs.size).toBe(0);
  });
  it('service-owned cleanup retries invalidate-time failures until the orphan is removed',async()=>{ // risk: orphan privileged tab
    const h=new Harness(); const {token}=h.service.mint('x',{enabled:true,allowedOrigins:[]}); await h.service.open(token,'https://example.com');
    h.browser.closeFailures=2; await h.service.invalidate(token);
    expect(h.service.pendingCleanupCount).toBe(1); expect(h.browser.openTabs.size).toBe(1);
    h.timers[1](); await Promise.resolve(); expect(h.service.pendingCleanupCount).toBe(1);
    h.timers[2](); await Promise.resolve(); expect(h.service.pendingCleanupCount).toBe(0); expect(h.browser.openTabs.size).toBe(0);
  });
  it('retains an adapter-reported failed open during overlapping invalidation until scheduled cleanup succeeds',async()=>{ // risk: orphan privileged tab
    const h=new Harness(); let release!:()=>void; h.browser.openGate=new Promise<void>(resolve=>{release=resolve}); h.browser.failOpenAfterCreate=true;
    const {token}=h.service.mint('x',{enabled:true,allowedOrigins:[]}); const opening=h.service.open(token,'https://example.com'); await Promise.resolve();
    const invalidating=h.service.invalidate(token); h.browser.closeFailures=1; release();
    await invalidating; await expect(opening).rejects.toThrow('open failed'); expect(h.service.pendingCleanupCount).toBe(1); expect(h.browser.openTabs.size).toBe(1);
    h.timers[1](); await Promise.resolve(); expect(h.service.pendingCleanupCount).toBe(0); expect(h.browser.openTabs.size).toBe(0);
  });
  it('shutdown backs off through the scheduler and completes after eventual cleanup success',async()=>{ // risk: shutdown hot-loop
    const h=new Harness(); const delays:number[]=[]; const callbacks:Array<()=>void>=[]; let now=0;
    const service=new FunctionBrowserCapabilityService(h.browser,()=>now,()=>`token-${++h.tokenNumber}`,new BrowserUrlPolicy(new Resolver()),(callback,delay)=>{callbacks.push(callback);delays.push(delay);return callbacks.length as any},()=>undefined);
    const {token}=service.mint('x',{enabled:true,allowedOrigins:[]}); await service.open(token,'https://example.com'); h.browser.closeFailures=3; await service.invalidate(token);
    const shuttingDown=service.shutdown(); for(let index=0;index<10;index++) await Promise.resolve(); expect(delays.at(-1)).toBe(100); expect(h.browser.closeFailures).toBe(1);
    now+=100; callbacks.at(-1)!(); for(let index=0;index<10;index++) await Promise.resolve(); expect(delays.at(-1)).toBe(200);
    now+=200; callbacks.at(-1)!(); await shuttingDown; expect(service.pendingCleanupCount).toBe(0); expect(delays.slice(-2)).toEqual([100,200]);
  });
  it('shutdown returns at its deadline after scheduled backoff for permanent failures',async()=>{ // risk: shutdown hang
    const h=new Harness(); const scheduled:Array<{callback:()=>void;delay:number}>=[]; let now=0;
    const service=new FunctionBrowserCapabilityService(h.browser,()=>now,()=>`token-${++h.tokenNumber}`,new BrowserUrlPolicy(new Resolver()),(callback,delay)=>{scheduled.push({callback,delay});return scheduled.length as any},()=>undefined);
    const {token}=service.mint('x',{enabled:true,allowedOrigins:[]}); await service.open(token,'https://example.com'); h.browser.closeFailures=Number.MAX_SAFE_INTEGER; await service.invalidate(token);
    const logged=vi.spyOn(console,'error').mockImplementation(()=>undefined); const shuttingDown=service.shutdown(); const drainDelays:number[]=[];
    for(let attempt=0;attempt<6;attempt++){ for(let index=0;index<10;index++) await Promise.resolve(); const timer=scheduled.at(-1)!; drainDelays.push(timer.delay); now+=timer.delay; timer.callback() }
    await shuttingDown; expect(now).toBe(5_000); expect(drainDelays).toEqual([100,200,400,800,1600,1900]); expect(service.pendingCleanupCount).toBe(1); expect(logged).toHaveBeenCalledWith('Browser tab cleanup deadline reached',expect.objectContaining({assetIds:expect.any(Array)})); logged.mockRestore();
  });
});
