// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { SullaFilesIpcPreviewService } from './SullaFilesIpcPreviewService';
import { FilesPreviewTokenRegistry } from './FilesPreviewTokenRegistry';

describe('SullaFilesIpcPreviewService', () => {
  // risk: relative asset availability — the isolated guest session must register the same scoped capability handler as the default Files preview session.
  it('serves capability assets from an additional isolated-session protocol', async() => {
    const makeProtocol = () => {
      let handler:((request:Request)=>Promise<Response>)|undefined;
      return {
        isProtocolHandled:()=>false,
        handle:(_scheme:string, callback:typeof handler)=>{ handler=callback },
        get handler() { return handler; },
      };
    };
    const defaultProtocol = makeProtocol();
    const guestProtocol = makeProtocol();
    const page = '<!doctype html><html><head></head><body><a href="https://example.com">External</a></body></html>';
    const api = {
      listingRequest:async()=>new Response(JSON.stringify([{ id:'file-html', path:'index.html' }, { id:'file-css', path:'site.css' }]), { status:200 }),
      client:{ stream:vi.fn(async(endpoint:string)=>new Response(endpoint.includes('file-html') ? page : 'body{color:red}', { status:200 })) },
      json:vi.fn(),
    };
    const tokens = new FilesPreviewTokenRegistry();
    const service = new SullaFilesIpcPreviewService(defaultProtocol as never, api as never, tokens);
    service.initialize();
    service.initialize(guestProtocol as never);
    const token = tokens.issue('collection', '', 'index.html');

    const defaultPage = await defaultProtocol.handler!({ url:`sulla-files-preview://${token}/index.html`, method:'GET' } as Request);
    const guestPage = await guestProtocol.handler!({ url:`sulla-files-preview://${token}/index.html`, method:'GET' } as Request);
    const guestAsset = await guestProtocol.handler!({ url:`sulla-files-preview://${token}/site.css`, method:'GET' } as Request);

    expect(defaultProtocol.handler).toBeTypeOf('function');
    expect(guestProtocol.handler).toBeTypeOf('function');
    expect(await defaultPage.text()).toContain('sulla-files-nav');
    expect(await guestPage.text()).toBe(page);
    expect(guestAsset.status).toBe(200);
    expect(await guestAsset.text()).toBe('body{color:red}');
  });

  // risk: preview isolation — only the top-level HTML receives the navigation bridge; assets remain untouched.
  it('injects navigation bridge only into the token root HTML document', async() => {
    let handler:((request:Request)=>Promise<Response>)|undefined;
    const protocol = { isProtocolHandled:()=>false, handle:(_scheme:string, callback:typeof handler)=>{ handler=callback } };
    const files = [{ id:'file-html', path:'index.html' }, { id:'file-css', path:'site.css' }];
    const api = {
      listingRequest:async()=>new Response(JSON.stringify(files), { status:200 }),
      client:{ stream:vi.fn(async(endpoint:string)=>new Response(endpoint.includes('file-html')?'<html><head></head><body></body></html>':'body{}', { status:200 })) },
      json:vi.fn(),
    };
    const tokens = new FilesPreviewTokenRegistry();
    const service = new SullaFilesIpcPreviewService(protocol as never, api as never, tokens);
    service.initialize();
    const token = tokens.issue('collection', '', 'index.html');
    const fetchPreview = (path:string) => handler!({ url:`sulla-files-preview://${token}/${path}`, method:'GET' } as Request);
    const html = await (await fetchPreview('index.html')).text();
    const css = await (await fetchPreview('site.css')).text();
    expect(html).toContain("kind:'relative'");
    expect(css).not.toContain('sulla-files-nav');
  });

  // risk: preview rendering — the injected bridge must close its script tag, or the whole page renders blank.
  it('closes the injected bridge script tag exactly once and the script body compiles', async() => {
    const html = await injectedHtml('index.html', 'index.html');
    expect(html.split('</script>').length - 1).toBe(1);
    expect(html.indexOf('</script>')).toBeGreaterThan(html.indexOf('<script>'));
    expect(html).toContain('<body></body>');
    const body = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'));
    expect(() => new Function(body)).not.toThrow();
  });

  // risk: preview navigation — the bridge's regexes must behave when run, not just compile.
  it('bridge classifies external and relative links when the script runs', async() => {
    const html = await injectedHtml('index.html', 'index.html');
    const body = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'));
    const posted:unknown[] = [];
    let onClick:((event:unknown)=>void)|undefined;
    const doc = { addEventListener:(_type:string, handler:(event:unknown)=>void) => { onClick = handler } };
    const parentWindow = { postMessage:(message:unknown) => posted.push(message) };
    new Function('document', 'parent', body)(doc, parentWindow);
    const click = (href:string) => {
      const link = { getAttribute:() => href };
      const event = { target:{ closest:() => link }, preventDefault:vi.fn() };
      onClick!(event);
      return event.preventDefault.mock.calls.length;
    };
    expect(click('https://example.com/a')).toBe(1);
    expect(posted.at(-1)).toEqual({ type:'sulla-files-nav', kind:'external', href:'https://example.com/a' });
    expect(click('other.html')).toBe(1);
    expect(posted.at(-1)).toEqual({ type:'sulla-files-nav', kind:'relative', href:'other.html' });
    expect(click('mailto:me@example.com')).toBe(0);
  });

  // risk: preview rendering — names needing URL encoding must still get the bridge.
  it('injects the bridge into a root HTML whose name needs URL encoding', async() => {
    const html = await injectedHtml('My Page.html', 'My%20Page.html');
    expect(html).toContain("kind:'relative'");
  });

  async function injectedHtml(rootDocument:string, requestPath:string):Promise<string> {
    let handler:((request:Request)=>Promise<Response>)|undefined;
    const protocol = { isProtocolHandled:()=>false, handle:(_scheme:string, callback:typeof handler)=>{ handler=callback } };
    const files = [{ id:'file-html', path:rootDocument }];
    const api = {
      listingRequest:async()=>new Response(JSON.stringify(files), { status:200 }),
      client:{ stream:vi.fn(async()=>new Response('<html><head></head><body></body></html>', { status:200 })) },
      json:vi.fn(),
    };
    const tokens = new FilesPreviewTokenRegistry();
    new SullaFilesIpcPreviewService(protocol as never, api as never, tokens).initialize();
    const token = tokens.issue('collection', '', rootDocument);
    return (await handler!({ url:`sulla-files-preview://${token}/${requestPath}`, method:'GET' } as Request)).text();
  }
});
