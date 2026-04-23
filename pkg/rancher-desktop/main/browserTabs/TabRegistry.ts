// TabRegistry.ts — Single source of truth for browser tabs.
//
// Owns the Map<assetId, WebContentsView> and all lifecycle. Agent tools
// resolve tabs by assetId here and get a GuestBridge back. The renderer UI
// subscribes to change events via IPC and renders a plain reflection of
// this state — it owns no tab state of its own.
//
// Previously this role was split across:
//   - BrowserTabViewManager (main, Map<tabId, WebContentsView>)
//   - HostBridgeRegistry (renderer, Map<assetId, bridge>)
//   - useBrowserTabs (renderer, reactive tabs list)
//   - AgentPersonaModel.activeAssets (renderer, second list synced via watcher)
//
// Four sources of truth kept diverging. One source eliminates whole classes
// of bugs: ghost tabs, stale bridges, infinite eviction loops.

import { EventEmitter } from 'node:events';

import { BrowserTabViewManager } from '@pkg/window/browserTabViewManager';

import { GuestBridge } from './GuestBridge';

export interface TabRecord {
  assetId:        string;
  title:          string;
  url:            string;
  isLoading:      boolean;
  origin:         'user' | 'agent';
  /** ms since epoch — used only for sorting display. No eviction, no idle sweep. */
  createdAt:      number;
  lastAccessedAt: number;
}

type TabsListener = (tabs: TabRecord[]) => void;

/**
 * Hard cap on concurrent agent-origin tabs. A runaway agent won't saturate
 * RAM by opening hundreds of pages; the oldest agent tab gets evicted when a
 * new one would push count over this limit. User-opened tabs are never
 * evicted by this.
 */
const MAX_AGENT_TABS = 10;

class TabRegistryImpl {
  private readonly records = new Map<string, TabRecord>();
  private readonly emitter = new EventEmitter();
  private activeAssetId: string | null = null;

  /** Close oldest agent tabs until we're under the cap. No-op if under. */
  private enforceCap(): void {
    const agentTabs = [...this.records.values()]
      .filter(t => t.origin === 'agent')
      .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    const overflow = agentTabs.length - MAX_AGENT_TABS;
    if (overflow <= 0) return;
    for (const t of agentTabs.slice(0, overflow)) {
      console.log(`[TabRegistry] evicting agent tab ${ t.assetId } (oldest, over cap ${ MAX_AGENT_TABS })`);
      this.close(t.assetId);
    }
  }

  /** Open or update a tab. Re-entrant: same assetId + URL is a no-op. */
  open(input: { assetId: string; url: string; title?: string; origin?: 'user' | 'agent' }): TabRecord {
    const existing = this.records.get(input.assetId);
    if (existing) {
      const sameUrl = existing.url === input.url;
      existing.title = input.title ?? existing.title;
      existing.url = input.url;
      existing.lastAccessedAt = Date.now();
      if (!sameUrl) {
        // Navigate the existing tab.
        const wc = BrowserTabViewManager.getInstance().getWebContents(input.assetId);
        wc?.loadURL(input.url).catch(() => {});
      }
      this.activeAssetId = input.assetId;
      this.notify();
      return existing;
    }

    // Create a new WebContentsView keyed by the SAME assetId as the map.
    // Default to 1280×800 so window.innerWidth/innerHeight are non-zero and
    // screenshots + getBoundingClientRect() work immediately. The UI overrides
    // these bounds via setBounds() when it actually displays the tab.
    BrowserTabViewManager.getInstance().createView(input.assetId, input.url, { x: 0, y: 0, width: 1280, height: 800 });

    const record: TabRecord = {
      assetId:        input.assetId,
      title:          input.title ?? input.url,
      url:            input.url,
      isLoading:      true,
      origin:         input.origin ?? 'agent',
      createdAt:      Date.now(),
      lastAccessedAt: Date.now(),
    };
    this.records.set(input.assetId, record);
    this.activeAssetId = input.assetId;
    if (record.origin === 'agent') this.enforceCap();
    this.notify();
    return record;
  }

  close(assetId: string): boolean {
    if (!this.records.has(assetId)) return false;
    BrowserTabViewManager.getInstance().destroyView(assetId);
    this.records.delete(assetId);
    if (this.activeAssetId === assetId) {
      this.activeAssetId = this.records.size > 0 ? [...this.records.keys()][0] : null;
    }
    this.notify();
    return true;
  }

  /** Returns a GuestBridge for the given assetId, or null if the tab doesn't exist. */
  bridge(assetId: string): GuestBridge | null {
    const wc = BrowserTabViewManager.getInstance().getWebContents(assetId);
    return wc ? new GuestBridge(wc, assetId) : null;
  }

  get(assetId: string): TabRecord | null {
    return this.records.get(assetId) ?? null;
  }

  list(): TabRecord[] {
    return [...this.records.values()];
  }

  getActiveAssetId(): string | null {
    return this.activeAssetId;
  }

  setActive(assetId: string): void {
    if (!this.records.has(assetId)) return;
    this.activeAssetId = assetId;
    const rec = this.records.get(assetId)!;
    rec.lastAccessedAt = Date.now();
    this.notify();
  }

  /** Update reactive title/url/loading fields from webContents navigation events. */
  updateMeta(assetId: string, patch: Partial<Pick<TabRecord, 'title' | 'url' | 'isLoading'>>): void {
    const rec = this.records.get(assetId);
    if (!rec) return;
    if (patch.title !== undefined) rec.title = patch.title;
    if (patch.url !== undefined) rec.url = patch.url;
    if (patch.isLoading !== undefined) rec.isLoading = patch.isLoading;
    this.notify();
  }

  onChange(listener: TabsListener): () => void {
    this.emitter.on('change', listener);
    return () => this.emitter.off('change', listener);
  }

  private notify(): void {
    this.emitter.emit('change', this.list());
  }
}

export const tabRegistry = new TabRegistryImpl();
