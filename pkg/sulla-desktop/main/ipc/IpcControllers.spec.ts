// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterization specs for the main-process IpcController classes: each
// registers the same channel names as the old init*Ipc() functions and
// delegates to its injected collaborators with the same return shapes.

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));
vi.mock('../../agent/integrations/packageLoader', () => ({ setIntegrationGrant: vi.fn() }));
vi.mock('../../agent/database/models/MarketplaceArtifactModel', () => ({ FunctionDefinitionModel: { list: vi.fn() }, IntegrationDefinitionModel: { list: vi.fn() } }));
vi.mock('../../agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { get: vi.fn(), set: vi.fn() } }));
vi.mock('../../agent/extensions/HookRegistry', () => ({ EXTENSION_HOOKS: { beforeSend: {} }, listExtensionHookAuditEvents: vi.fn(() => []), setExtensionHookGrant: vi.fn() }));
vi.mock('../../agent/extensions/ExtensionUIRegistry', () => ({ extensionUI: { list: vi.fn(() => []) } }));

import { AgentTabContractIpcController } from '../agentTabContractIpc';
import { BookmarksIpcController } from '../bookmarksIpc';
import { TabsIpcController } from '../browserTabs/tabsIpc';
import { ChatArtifactsIpcController } from '../chatArtifactsIpc';
import { ChatHeartbeatIpcController } from '../chatHeartbeatIpc';
import { ChatMessagesIpcController } from '../chatMessagesIpc';
import { ConversationMessagesIpcController } from '../conversationMessagesIpc';
import { ExtensionUiIpcController } from '../extensionUiIpc';
import { IntegrationGrantIpcController } from '../integrationGrantIpc';
import { MessageBusIpcController } from '../messageBusIpc';
import { ModelDefaultsIpcController } from '../modelDefaultsIpc';
import { ModelRoutingIpcController } from '../modelRoutingIpc';
import { SullaBundleIpcController } from '../sullaBundleEvents';
import { SullaPatchIpcController } from '../sullaPatchEvents';
import { SupportSessionCloudClient, SupportSessionIpcController } from '../supportSessionIpc';
import { UsageIpcController } from '../usageEvents';

class FakeIpc {
  readonly handlers = new Map<string, (...args: any[]) => any>();
  readonly listeners = new Map<string, (...args: any[]) => any>();
  readonly removed: string[] = [];
  handle(channel: string, fn: (...args: any[]) => any) {
    if (this.handlers.has(channel)) throw new Error(`duplicate handler ${ channel }`);
    this.handlers.set(channel, fn);
  }

  on(channel: string, fn: (...args: any[]) => any) { this.listeners.set(channel, fn) }
  removeHandler(channel: string) { this.removed.push(channel); this.handlers.delete(channel) }
  invoke(channel: string, ...args: any[]) {
    const fn = this.handlers.get(channel);
    if (!fn) throw new Error(`no handler ${ channel }`);

    return fn(...args);
  }
}

const log = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };
const guard = { run: (_label: string, read: () => Promise<any>) => read() };

describe('IpcController channel registration', () => {
  const cases: [string, (ipc: FakeIpc) => { register(): void }, string[]][] = [
    ['integration grants', ipc => new IntegrationGrantIpcController(ipc, { setGrant: vi.fn(), refreshCatalog: vi.fn() }), ['integration-grants:grant', 'integration-grants:revoke']],
    ['agent tab contract', ipc => new AgentTabContractIpcController(ipc, { acknowledgeReady: vi.fn(), snapshot: vi.fn() }), ['agent-tab:ready']],
    ['model defaults', ipc => new ModelDefaultsIpcController(ipc, { state: vi.fn(), set: vi.fn(), reset: vi.fn() }), ['model-defaults:get', 'model-defaults:set', 'model-defaults:reset']],
    ['support sessions', ipc => new SupportSessionIpcController(ipc, new SupportSessionCloudClient(vi.fn())), ['support-session:get', 'support-session:events', 'support-session:end', 'support-session:extend', 'support-session:presence']],
    ['conversation messages', ipc => new ConversationMessagesIpcController(ipc, { appendMany: vi.fn(), list: vi.fn(), count: vi.fn() }, log), ['conversation-messages:append', 'conversation-messages:list', 'conversation-messages:count']],
    ['tabs', ipc => new TabsIpcController(ipc, { list: vi.fn(), getActiveAssetId: vi.fn(), open: vi.fn(), close: vi.fn(), setActive: vi.fn(), onChange: vi.fn() }, { allWebContents: () => [], browserSession: () => null, send: vi.fn() }), ['tabs:list', 'tabs:active', 'tabs:open', 'tabs:close', 'tabs:setActive']],
    ['model routing', ipc => new ModelRoutingIpcController(ipc, { router: { onStatusChange: vi.fn() } as any, recommendedState: vi.fn(), listAgents: vi.fn(), onIntegrationValueChange: vi.fn(), broadcast: vi.fn() }), ['model-routing:get', 'model-routing:set', 'model-routing:reset', 'model-routing:refresh']],
    ['chat heartbeat', ipc => new ChatHeartbeatIpcController(ipc, () => ({}) as any), ['chat-heartbeat:register', 'chat-heartbeat:set', 'chat-heartbeat:busy', 'chat-heartbeat:unregister']],
    ['extension ui', ipc => new ExtensionUiIpcController(ipc, { readGuard: guard as any, onHookAudit: vi.fn(async() => undefined), broadcast: vi.fn() }), ['extensions-ui:list', 'extension-permissions:list', 'extension-permissions:audit', 'extension-permissions:set-hook', 'extension-permissions:revoke-all', 'extension-permissions:set-rail-hidden']],
    ['chat messages', ipc => new ChatMessagesIpcController(ipc, { saveThreadState: vi.fn(), loadThreadState: vi.fn(), loadMessagesBefore: vi.fn(), deleteThreadState: vi.fn(), deleteMessages: vi.fn(), getMessageCount: vi.fn() }, log), ['chat-messages:save', 'chat-messages:load', 'chat-messages:load-before', 'chat-messages:delete', 'chat-messages:delete-messages', 'chat-messages:message-count']],
    ['chat artifacts', ipc => new ChatArtifactsIpcController(ipc, { service: () => ({}) as any, readGuard: guard as any, getArtifactById: vi.fn(), getHistoryByThread: vi.fn() }), ['chat-artifacts:list', 'chat-artifacts:get', 'chat-artifacts:open-file', 'chat-artifacts:get-by-id', 'chat-artifacts:save', 'chat-artifacts:close', 'chat-artifacts:focus', 'chat-artifacts:reopen', 'chat-artifacts:retry-files-registration']],
    ['bookmarks', ipc => new BookmarksIpcController(ipc, { bookmarks: {} as any, configureArtifactSync: vi.fn(), listDockerLinks: vi.fn(), isAppWindow: () => true }), ['bookmarks:list', 'bookmarks:create', 'bookmarks:update', 'bookmarks:delete', 'bookmarks:move', 'bookmarks:docker-links']],
    ['message bus', ipc => new MessageBusIpcController(ipc, { bus: () => ({ dispatch: vi.fn(), send: vi.fn() }), allWebContents: () => [], send: vi.fn(), log: vi.fn() }), ['message-bus:connect']],
    ['usage', ipc => new UsageIpcController(ipc, { summary: vi.fn(), activeContractorId: vi.fn() }), ['usage:summary']],
    ['bundles', ipc => new SullaBundleIpcController(ipc, { install: vi.fn(), publish: vi.fn() }, log), ['bundles-install-from-marketplace', 'bundles-publish', 'bundles-publish-bulk-from-dir']],
    ['patch revert', ipc => new SullaPatchIpcController(ipc, { readFile: vi.fn(), writeFile: vi.fn() }, log), ['patch:revert']],
  ];

  it.each(cases)('%s registers exactly its original channels', (_name, build, channels) => {
    const ipc = new FakeIpc();
    build(ipc).register();
    expect([...ipc.handlers.keys()]).toEqual(channels);
  });
});

describe('IpcController delegation', () => {
  it('integration grant: grant stores granted permissions then refreshes the catalog; revoke clears them', async() => {
    const ipc = new FakeIpc();
    const store = { setGrant: vi.fn(async() => undefined), refreshCatalog: vi.fn(async() => undefined) };
    new IntegrationGrantIpcController(ipc, store).register();
    await ipc.invoke('integration-grants:grant', {}, { id: 'acme', version: '1.0.0', permissions: ['net'] });
    await ipc.invoke('integration-grants:revoke', {}, { id: 'acme', version: '1.0.0' });
    expect(store.setGrant.mock.calls).toEqual([['acme', '1.0.0', ['net'], true], ['acme', '1.0.0', [], false]]);
    expect(store.refreshCatalog).toHaveBeenCalledTimes(2);
  });

  it('agent tab: blank ids return an empty snapshot without acknowledging', async() => {
    const ipc = new FakeIpc();
    const tabs = { acknowledgeReady: vi.fn(), snapshot: vi.fn(() => ({ messages: [1] })) };
    new AgentTabContractIpcController(ipc, tabs).register();
    expect(await ipc.invoke('agent-tab:ready', {}, { contractId: ' ', threadId: 't' })).toEqual({ messages: [] });
    expect(tabs.acknowledgeReady).not.toHaveBeenCalled();
    expect(await ipc.invoke('agent-tab:ready', {}, { contractId: ' c ', threadId: 't' })).toEqual({ messages: [1] });
    expect(tabs.acknowledgeReady).toHaveBeenCalledWith('c', 't');
  });

  it('model defaults: removes stale handlers first and returns fresh state after set', async() => {
    const ipc = new FakeIpc();
    const defaults = { state: vi.fn(() => 'state'), set: vi.fn(async() => undefined), reset: vi.fn(async() => undefined) };
    new ModelDefaultsIpcController(ipc, defaults).register();
    expect(ipc.removed).toEqual(['model-defaults:get', 'model-defaults:set', 'model-defaults:reset']);
    expect(await ipc.invoke('model-defaults:set', {}, null)).toBe('state');
    expect(defaults.set).toHaveBeenCalledWith({});
  });

  it('support session: missing session throws session_not_found (404)', async() => {
    const ipc = new FakeIpc();
    const cloudRequest = vi.fn(async() => ({ ok: true, json: async() => ({ sessions: [{ id: 'a' }] }) }) as any);
    new SupportSessionIpcController(ipc, new SupportSessionCloudClient(cloudRequest)).register();
    expect(await ipc.invoke('support-session:get', {}, 'a')).toEqual({ session: { id: 'a' } });
    await expect(ipc.invoke('support-session:get', {}, 'b')).rejects.toMatchObject({ code: 'session_not_found', status: 404 });
  });

  it('support session: cloud errors carry code and status; end posts the reason', async() => {
    const ipc = new FakeIpc();
    const cloudRequest = vi.fn(async() => ({ ok: false, status: 403, json: async() => ({ error: 'forbidden' }) }) as any);
    const supportLog = vi.fn();
    new SupportSessionIpcController(ipc, new SupportSessionCloudClient(cloudRequest), supportLog).register();
    await expect(ipc.invoke('support-session:end', {}, 'a b')).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    expect(cloudRequest).toHaveBeenCalledWith('POST', '/super-admin/support/sessions/a%20b/end', expect.objectContaining({ body: JSON.stringify({ reason: 'resolved' }) }));
    expect(supportLog).toHaveBeenCalledWith('[support-session] request failed', { channel: 'support-session:end', code: 'forbidden', status: 403 });
  });

  it('conversation messages: store failures return success:false with safe defaults', async() => {
    const ipc = new FakeIpc();
    const store = { appendMany: vi.fn(async() => undefined), list: vi.fn(async() => { throw new Error('db down') }), count: vi.fn(async() => { throw new Error('db down') }) };
    new ConversationMessagesIpcController(ipc, store, log).register();
    expect(await ipc.invoke('conversation-messages:append', {}, { id: 1 })).toEqual({ success: true });
    expect(store.appendMany).toHaveBeenCalledWith([{ id: 1 }]);
    expect(await ipc.invoke('conversation-messages:list', {}, 'c')).toMatchObject({ success: false, data: [] });
    expect(await ipc.invoke('conversation-messages:count', {}, 'c')).toMatchObject({ success: false, data: 0 });
  });

  it('tabs: change broadcast skips browser-session guests', () => {
    const ipc = new FakeIpc();
    let onChange: (tabs: any[]) => void = () => undefined;
    const registry = { list: vi.fn(), getActiveAssetId: vi.fn(), open: vi.fn(), close: vi.fn(), setActive: vi.fn(), onChange: vi.fn((fn) => { onChange = fn }) };
    const browserSession = {} as any;
    const app = { session: {} } as any;
    const guest = { session: browserSession } as any;
    const send = vi.fn();
    new TabsIpcController(ipc, registry, { allWebContents: () => [app, guest], browserSession: () => browserSession, send }).register();
    onChange([{ assetId: 'x' }]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(app, 'tabs:change', [{ assetId: 'x' }]);
    ipc.invoke('tabs:open', {}, { assetId: 'a', url: 'https://x', title: 'X' });
    expect(registry.open).toHaveBeenCalledWith({ assetId: 'a', url: 'https://x', title: 'X', origin: 'user' });
  });

  it('model routing: invalid reset target is refused before touching the router', async() => {
    const ipc = new FakeIpc();
    const router = { getEditableState: vi.fn(async() => ({})), providerInfo: vi.fn(async() => []), catalogReport: vi.fn(async() => ({})), set: vi.fn(), reset: vi.fn(), refreshCatalog: vi.fn(), onStatusChange: vi.fn() };
    new ModelRoutingIpcController(ipc, { router, recommendedState: () => ({}), listAgents: async() => [{ name: 'A', enabled: true, model_choice: { mode: 'class', class: 'Fast' } }], onIntegrationValueChange: vi.fn(), broadcast: vi.fn() }).register();
    await expect(ipc.invoke('model-routing:reset', {}, { section: 'bogus' })).rejects.toThrow('Invalid model routing reset target');
    expect(router.reset).not.toHaveBeenCalled();
  });

  it('chat heartbeat: register requires a thread id; set reports unregistered threads', () => {
    const ipc = new FakeIpc();
    const service = { register: vi.fn(() => 'on'), configure: vi.fn(() => null), updateBusy: vi.fn(), unregister: vi.fn() };
    new ChatHeartbeatIpcController(ipc, () => service as any).register();
    expect(ipc.invoke('chat-heartbeat:register', {}, { threadId: '  ' })).toEqual({ success: false, error: 'threadId is required' });
    expect(ipc.invoke('chat-heartbeat:set', {}, { threadId: 't', config: {} })).toEqual({ success: false, error: 'chat heartbeat is not registered' });
    expect(ipc.invoke('chat-heartbeat:unregister', {}, ' t ')).toEqual({ success: true });
    expect(service.unregister).toHaveBeenCalledWith('t');
  });

  it('chat artifacts: get-by-id hides deleted histories', async() => {
    const ipc = new FakeIpc();
    new ChatArtifactsIpcController(ipc, { service: () => ({}) as any, readGuard: guard as any, getArtifactById: async() => ({ threadId: 't' }), getHistoryByThread: async() => ({ status: 'deleted' }) }).register();
    expect(await ipc.invoke('chat-artifacts:get-by-id', {}, { artifactId: ' a ' })).toEqual({ threadId: 't', artifact: { threadId: 't' }, history: null });
  });

  it('bookmarks: refuses calls from non-app frames (permissions)', async() => {
    const ipc = new FakeIpc();
    const bookmarks = { list: vi.fn(async() => []) } as any;
    new BookmarksIpcController(ipc, { bookmarks, configureArtifactSync: vi.fn(), listDockerLinks: vi.fn(), isAppWindow: () => true }).register();
    const mainFrame = { url: 'https://evil.example' };
    await expect(ipc.invoke('bookmarks:list', { sender: { mainFrame }, senderFrame: mainFrame })).rejects.toThrow('Only the Desktop application');
    expect(bookmarks.list).not.toHaveBeenCalled();
    const appFrame = { url: 'app://index.html' };
    expect(await ipc.invoke('bookmarks:list', { sender: { mainFrame: appFrame }, senderFrame: appFrame })).toEqual([]);
  });

  it('message bus: subscriptions are per controller and sends are not echoed to the sender', async() => {
    const ipc = new FakeIpc();
    const bus = { dispatch: vi.fn(), send: vi.fn(async() => true) };
    const send = vi.fn();
    const wcs = [{ id: 1 }, { id: 2 }];
    new MessageBusIpcController(ipc, { bus: () => bus, allWebContents: () => wcs, send, log: vi.fn() }).register();
    const sender = (id: number) => ({ sender: { id, once: vi.fn() } });
    ipc.invoke('message-bus:connect', sender(1), 'ch');
    ipc.invoke('message-bus:connect', sender(2), 'ch');
    ipc.listeners.get('message-bus:send')!(sender(1), 'ch', { type: 'x' });
    expect(bus.dispatch).toHaveBeenCalledWith('ch', { type: 'x' });
    expect(send.mock.calls).toEqual([[wcs[1], 'message-bus:message', 'ch', { type: 'x' }]]);
    send.mockClear();
    await bus.send('ch', 'raw');
    expect(send).toHaveBeenCalledWith(wcs[0], 'message-bus:message', 'ch', { type: 'message', data: 'raw' });
  });

  it('usage: falls back to the default profile when no contractor is signed in', async() => {
    const ipc = new FakeIpc();
    const summary = vi.fn(async() => 'ok');
    new UsageIpcController(ipc, { summary, activeContractorId: async() => { throw new Error('offline') } }).register();
    expect(await ipc.invoke('usage:summary', {}, { hours: 24 })).toBe('ok');
    expect(summary).toHaveBeenCalledWith(24, 'default');
  });

  it('bundles: recipes publish by extensionId; install errors return { error }', async() => {
    const ipc = new FakeIpc();
    const marketplace = { install: vi.fn(async() => { throw new Error('boom') }), publish: vi.fn(async() => 'published') };
    new SullaBundleIpcController(ipc, marketplace, log).register();
    expect(await ipc.invoke('bundles-install-from-marketplace', {}, 'tpl')).toEqual({ error: 'boom' });
    expect(await ipc.invoke('bundles-publish', {}, { kind: 'recipe', extensionId: 'r1', slug: 'ignored' })).toBe('published');
    expect(marketplace.publish).toHaveBeenCalledWith({ kind: 'recipe', slug: 'r1', overrides: undefined });
  });

  it('patch revert: refuses to write when the file no longer has the new text (irreversible side effect)', async() => {
    const ipc = new FakeIpc();
    const files = { readFile: vi.fn(async() => 'changed again'), writeFile: vi.fn() };
    new SullaPatchIpcController(ipc, files, log).register();
    expect(await ipc.invoke('patch:revert', {}, { op: 'edit', path: '/f', oldString: 'a', newString: 'b' })).toMatchObject({ ok: false });
    expect(files.writeFile).not.toHaveBeenCalled();
    files.readFile.mockResolvedValueOnce('x b b');
    expect(await ipc.invoke('patch:revert', {}, { op: 'edit', path: '/f', oldString: 'a', newString: 'b' })).toEqual({ ok: true });
    expect(files.writeFile).toHaveBeenCalledWith('/f', 'x a b', 'utf-8');
  });
});
