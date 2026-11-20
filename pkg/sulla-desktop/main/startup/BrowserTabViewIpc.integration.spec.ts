// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { describe, it } from 'vitest';

/** Executes actual main/renderer sources with only native and Vue scheduling ports stubbed. */
class BrowserAttachmentIntegration {
  readonly root = process.cwd();
  source(file: string): string { return readFileSync(path.join(this.root, 'pkg/sulla-desktop', file), 'utf8'); }
  evaluate(source: string, globals: Record<string, unknown>, result: string): any {
    const script = stripTypeScriptTypes(source.replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, ''), { mode: 'transform' });
    return vm.runInNewContext(`${script}\n;${result}`, globals);
  }

  async verify(): Promise<void> {
    const owner = { id: 1, isDestroyed: () => false };
    const wrongOwner = { id: 2, isDestroyed: () => false };
    const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
    const navigations: string[] = [];
    const focus: unknown[] = [];
    const manager = {
      createView: () => undefined,
      ownsTab: (_id: string, window: unknown) => window === owner,
      getOwnerWindow: () => owner,
      setBounds: () => true,
      setFocusedTab: (id: unknown) => focus.push(id),
      wakeView: () => undefined,
      getWebContents: () => ({ loadURL: (url: string) => { navigations.push(url); return Promise.resolve(); } }),
    };
    const { EventEmitter } = await import('node:events');
    const registry = this.evaluate(this.source('main/browserTabs/TabRegistry.ts'), {
      EventEmitter, BrowserTabViewManager: { getInstance: () => manager }, setTimeout: () => 0,
    }, 'tabRegistry');
    const graphOwner = { kind: 'graph', sessionId: 'graph-one' };
    const record = registry.open({ assetId: 'graph-tab', url: 'https://graph.example/current', owner: graphOwner });
    const original = JSON.stringify(record);
    const Ipc = this.evaluate(this.source('main/startup/BrowserTabViewIpc.ts').replace(/await import\(/g, 'await ports('), {
      startEventLoopLagMonitor: () => undefined,
      agentWindowFromSender: (sender: unknown) => sender,
      ports: async(id: string) => id.includes('TabRegistry') ? { tabRegistry: registry } : { BrowserTabViewManager: { getInstance: () => manager } },
    }, 'BrowserTabViewIpc');
    await new Ipc().register({ ipc: { handle: (name: string, handler: any) => handlers.set(name, handler) } });
    const invoke = (name: string, ...args: unknown[]) => handlers.get(name)?.({ sender: owner }, ...args) ?? Promise.resolve();
    const renderer = this.source('pages/BrowserTab.vue');
    const ensure = renderer.slice(renderer.indexOf('function ensureView('), renderer.indexOf('\nfunction navigate()'));
    const visibility = renderer.slice(renderer.indexOf('const shouldShowView = computed('), renderer.indexOf('// ── Lifecycle', renderer.indexOf('const shouldShowView = computed(')));
    const state = {
      props: { tabId: 'graph-tab', isVisible: true }, viewCreated: { value: false },
      showOverlay: { value: false }, loggedIn: { value: true }, tabMode: { value: 'browser' },
      viewContainerRef: { value: null }, loading: { value: true }, browserActionError: { value: '' },
      vaultPopupOpen: { value: false }, window: { innerHeight: 800, addEventListener() {}, removeEventListener() {} },
      ipcRenderer: { invoke }, nextTick: (callback: () => void) => callback(),
      sendBounds() {}, onKeydown() {}, lastSentBounds: '', resizeObserver: null,
      computed: (callback: () => boolean) => ({ get value() { return callback(); } }),
      watch: (_value: unknown, callback: (visible: boolean) => void) => { watcher = callback; },
    };
    let watcher: (visible: boolean) => void = () => undefined;
    const ui = this.evaluate(`${ensure}\n${visibility}`, state, '({ ensureView, shouldShowView })');
    ui.ensureView('https://stale-renderer.example/');
    // Drain the actual IPC/renderer promise chain, including the failure catch.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    // risk: graph attachment failure silently disables all subsequent renderer visibility.
    assert.equal(state.viewCreated.value, true);
    assert.equal(state.browserActionError.value, '');
    assert.equal(ui.shouldShowView.value, true);
    watcher(ui.shouldShowView.value);
    await Promise.resolve();
    assert.deepEqual(focus, ['graph-tab']);
    assert.equal(JSON.stringify(record), original);
    assert.deepEqual(navigations, []);
    await invoke('browser-tab-view:create', 'graph-tab', 'https://another-stale.example/', {});
    assert.equal(JSON.stringify(record), original);
    // risk: window custody cannot authorize another shell's attachment or URL takeover.
    await assert.rejects(handlers.get('browser-tab-view:create')!({ sender: wrongOwner }, 'graph-tab', 'https://attack.example/', {}), /not owned/);
    assert.equal(JSON.stringify(record), original);
    // risk: successful attachment must not bypass login, overlay, hidden-tab or mode gates.
    state.loggedIn.value = false;
    assert.equal(ui.shouldShowView.value, false);
    state.loggedIn.value = true; state.showOverlay.value = true;
    assert.equal(ui.shouldShowView.value, false);
    state.showOverlay.value = false; state.props.isVisible = false;
    assert.equal(ui.shouldShowView.value, false);
    state.props.isVisible = true; state.tabMode.value = 'chat';
    assert.equal(ui.shouldShowView.value, false);
    state.tabMode.value = 'browser';
    await assert.rejects(handlers.get('browser-tab-view:create')!({ sender: null }, 'graph-tab', '', {}), /Untrusted/);
    await invoke('browser-tab-view:create', 'fresh-user', 'https://user.example/', {});
    assert.equal(registry.get('fresh-user').url, 'https://user.example/');
    assert.equal(registry.get('fresh-user').origin, 'user');
    assert.throws(() => registry.open({ assetId: 'graph-tab', url: 'https://attack.example/' }), /different browser session/);
  }
}

describe('create IPC to renderer visibility integration', () => {
  it('attaches a graph-owned record only in its owner window without navigation or visibility bypass', async() => {
    await new BrowserAttachmentIntegration().verify();
  });
});
