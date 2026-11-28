// SPDX-License-Identifier: GPL-2.0-or-later
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';
import { InlineHtmlPreviewSessionPolicy } from './InlineHtmlPreviewSessionPolicy';

class FakeSession {
  beforeRequest?: (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void;
  permissionRequestHandler?: (...args: any[]) => void;
  permissionCheckHandler?: (...args: any[]) => boolean;
  readonly webRequest = {
    onBeforeRequest: vi.fn((_filter: unknown, listener: typeof this.beforeRequest) => { this.beforeRequest = listener; }),
  };
  readonly resolveHost = vi.fn(async() => ({ endpoints: [{ address: '93.184.216.34', family: 'ipv4' as const }] }));
  readonly setPermissionRequestHandler = vi.fn((handler: typeof this.permissionRequestHandler) => { this.permissionRequestHandler = handler; });
  readonly setPermissionCheckHandler = vi.fn((handler: typeof this.permissionCheckHandler) => { this.permissionCheckHandler = handler; });
}

class FakeWebContents extends EventEmitter {
  openHandler?: (details: { url: string }) => { action: string };
  constructor(readonly session: FakeSession) { super(); }
  setWindowOpenHandler(handler: typeof this.openHandler): void { this.openHandler = handler; }
}

function createPolicy(now: () => number = () => 1_000): {
  app: EventEmitter;
  session: FakeSession;
  guest: FakeWebContents;
  openUrl: ReturnType<typeof vi.fn>;
} {
  const app = new EventEmitter();
  const session = new FakeSession();
  const openUrl = vi.fn();
  const policy = new InlineHtmlPreviewSessionPolicy(
    session as never,
    app as never,
    openUrl,
    url => url.protocol === 'sulla-files-preview:' && url.hostname === 'valid-token',
    'sulla-inline-html-preview',
    now,
  );
  policy.install();
  const guest = new FakeWebContents(session);
  app.emit('web-contents-created', {}, guest);
  return { app, session, guest, openUrl };
}

async function request(session: FakeSession, url: string): Promise<{ cancel: boolean }> {
  return new Promise(resolve => session.beforeRequest!({ url }, resolve));
}

describe('InlineHtmlPreviewSessionPolicy', () => {
  // risk: external navigation and tab flooding — every popup is denied, only public HTTP(S) links reach the app's tab opener, and bursts are capped.
  it('denies popups and routes rate-limited public HTTP(S) destinations through the Sulla tab opener', async() => {
    let now = 1_000;
    const { guest, openUrl } = createPolicy(() => now);

    expect(guest.openHandler!({ url: 'https://example.com/docs' })).toEqual({ action: 'deny' });
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://example.com/docs'));
    expect(guest.openHandler!({ url: 'app://./index.html' })).toEqual({ action: 'deny' });
    expect(guest.openHandler!({ url: 'file:///Users/example/secret.txt' })).toEqual({ action: 'deny' });
    expect(openUrl).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 6; index++) guest.openHandler!({ url: `https://example.com/${index}` });
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledTimes(5));
    expect(openUrl).not.toHaveBeenCalledWith('https://example.com/5');

    now += 60_001;
    guest.openHandler!({ url: 'http://example.org/' });
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith('http://example.org/'));
  });

  // risk: app escape — a preview cannot navigate the app window to app:// or file://, and public links are rerouted instead of navigating the guest.
  it('blocks navigation away from the preview document and routes only public web links', async() => {
    const { guest, openUrl } = createPolicy();
    const preventDefault = vi.fn();
    guest.emit('will-navigate', { preventDefault }, 'app://./index.html');
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(openUrl).not.toHaveBeenCalled();

    const externalPreventDefault = vi.fn();
    guest.emit('will-navigate', { preventDefault: externalPreventDefault }, 'https://example.com/page');
    expect(externalPreventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://example.com/page'));
  });

  // risk: permission escalation — every permission request and permission check in the guest session is refused.
  it('denies every session permission request and check', () => {
    const { session, guest } = createPolicy();
    const callback = vi.fn();
    session.permissionRequestHandler!(guest, 'geolocation', callback, {});
    expect(callback).toHaveBeenCalledWith(false);
    expect(session.permissionCheckHandler!(guest, 'media', '', {})).toBe(false);
  });

  // risk: local service and file access — requests to private, loopback, link-local, app and file targets are blocked; only active Files capability origins are allowed.
  it('blocks private-network requests and app/file URLs while allowing the active capability origin', async() => {
    const { session } = createPolicy();
    session.resolveHost.mockResolvedValueOnce({ endpoints: [{ address: '192.168.1.17', family: 'ipv4' as const }] });
    expect(await request(session, 'http://127.0.0.1:4312/')).toEqual({ cancel: true });
    expect(await request(session, 'http://[::ffff:7f00:1]:4312/')).toEqual({ cancel: true });
    expect(await request(session, 'http://[64:ff9b::7f00:1]/')).toEqual({ cancel: true });
    expect(await request(session, 'https://169.254.169.254/latest/meta-data/')).toEqual({ cancel: true });
    expect(await request(session, 'http://files.internal.example/')).toEqual({ cancel: true });
    expect(session.resolveHost).toHaveBeenCalledWith('files.internal.example', { source: 'system', cacheUsage: 'allowed' });
    expect(await request(session, 'app://example.com/index.html')).toEqual({ cancel: true });
    expect(await request(session, 'file://example.com/Users/example/secret.txt')).toEqual({ cancel: true });
    expect(await request(session, 'app://./index.html')).toEqual({ cancel: true });
    expect(await request(session, 'file:///Users/example/secret.txt')).toEqual({ cancel: true });
    expect(await request(session, 'sulla-files-preview://valid-token/Projects/synthetic/style.css')).toEqual({ cancel: false });
    expect(await request(session, 'sulla-files-preview://expired-token/Projects/synthetic/style.css')).toEqual({ cancel: true });
    expect(await request(session, 'https://example.com/style.css')).toEqual({ cancel: false });
  });

  // risk: guest renderer compromise — a weakened webview cannot attach, and an accepted guest gets dialogs disabled with no preload or popup privilege.
  it('rejects weakened webview preferences and pins the isolated guest settings', () => {
    const { app, session } = createPolicy();
    const host = new FakeWebContents(session);
    app.emit('web-contents-created', {}, host);
    const prevented = vi.fn();
    const weakened = {
      partition: 'sulla-inline-html-preview',
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      disableDialogs: false,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      preload: '/tmp/untrusted-preload.js',
    };
    const params: Record<string, string> = { partition: 'sulla-inline-html-preview', src: 'data:text/html,<script>run()</script>', allowpopups: '' };
    host.emit('will-attach-webview', { preventDefault: prevented }, weakened, params);

    expect(prevented).toHaveBeenCalledOnce();
    expect(weakened).toMatchObject({
      partition: 'sulla-inline-html-preview', nodeIntegration: false, contextIsolation: true,
      sandbox: true, webSecurity: true, disableDialogs: true, allowRunningInsecureContent: false,
      nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
      webviewTag: false, devTools: false,
    });
    expect(weakened.preload).toBeUndefined();
    expect(params.allowpopups).toBeUndefined();
    expect(params.webpreferences).toContain('disableDialogs=yes');
    expect(params.webpreferences).toContain('nodeIntegrationInSubFrames=no');
    expect(params.webpreferences).toContain('nodeIntegrationInWorker=no');
  });

  // risk: popup escape — even an otherwise secure webview cannot attach with the allowpopups attribute.
  it('rejects a popup-enabled webview even when the other preferences are safe', () => {
    const { app, session } = createPolicy();
    const host = new FakeWebContents(session);
    app.emit('web-contents-created', {}, host);
    const prevented = vi.fn();
    const secure = { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, disableDialogs: true };
    host.emit('will-attach-webview', { preventDefault: prevented }, secure, {
      partition: 'sulla-inline-html-preview',
      src: 'data:text/html,<p>preview</p>',
      allowpopups: '',
    });

    expect(prevented).toHaveBeenCalledOnce();
  });

  // risk: chat availability — even pages that call alert(), confirm(), or prompt() must never open modal dialogs over the chat.
  it('pins JavaScript dialogs off in the guest before the page can execute', () => {
    const { app, session } = createPolicy();
    const host = new FakeWebContents(session);
    app.emit('web-contents-created', {}, host);
    const preferences = { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true };
    const params: Record<string, string> = { partition: 'sulla-inline-html-preview', src: 'data:text/html,<script>alert(1);confirm(1);prompt(1)</script>' };

    host.emit('will-attach-webview', { preventDefault: vi.fn() }, preferences, params);

    expect(preferences).toMatchObject({ disableDialogs: true });
    expect(params.webpreferences).toContain('disableDialogs=yes');
    expect(params.allowpopups).toBeUndefined();
  });

  // risk: renderer escape — the preview session must never be reused for a guest assigned to another partition.
  it('rejects webviews that request any partition other than the dedicated in-memory partition', () => {
    const { app, session } = createPolicy();
    const host = new FakeWebContents(session);
    app.emit('web-contents-created', {}, host);
    const prevented = vi.fn();

    host.emit('will-attach-webview', { preventDefault: prevented }, {}, {
      partition: 'persist:default',
      src: 'data:text/html,<p>untrusted</p>',
    });

    expect(prevented).toHaveBeenCalledOnce();
  });

  // risk: app webview regression — the preview policy must not disable or rewrite unrelated trusted app guests.
  it('leaves unrelated app webviews outside the preview partition untouched', () => {
    const { app, session } = createPolicy();
    const host = new FakeWebContents(session);
    app.emit('web-contents-created', {}, host);
    const prevented = vi.fn();
    const preferences = { nodeIntegration: true, contextIsolation: false, webSecurity: false };
    const params = { partition: 'persist:agent-assets', src: 'https://assets.example.test/preview' };

    host.emit('will-attach-webview', { preventDefault: prevented }, preferences, params);

    expect(prevented).not.toHaveBeenCalled();
    expect(preferences).toEqual({ nodeIntegration: true, contextIsolation: false, webSecurity: false });
    expect(params).toEqual({ partition: 'persist:agent-assets', src: 'https://assets.example.test/preview' });
  });
});
