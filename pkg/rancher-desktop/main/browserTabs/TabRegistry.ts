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

import { GuestBridge } from './GuestBridge';

import { BrowserTabViewManager } from '@pkg/window/browserTabViewManager';

export interface TabRecord {
  assetId:        string;
  title:          string;
  url:            string;
  isLoading:      boolean;
  origin:         'user' | 'agent';
  /** Scheduled-graph session that exclusively owns this tab, when applicable. */
  owner?:         TabOwner;
  /** ms since epoch — used only for sorting display. No eviction, no idle sweep. */
  createdAt:      number;
  lastAccessedAt: number;
}

export interface TabOwner {
  kind:      'graph';
  sessionId: string;
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
  /** Includes pre-open reservations so ownership checks remain atomic across delegation. */
  private readonly owners = new Map<string, TabOwner>();
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

  private sameOwner(left?: TabOwner, right?: TabOwner): boolean {
    return left?.kind === right?.kind && left?.sessionId === right?.sessionId;
  }

  private ownershipError(assetId: string): Error {
    return new Error(`Browser tab "${ assetId }" is owned by a different browser session.`);
  }

  /**
   * Atomically reserve an asset ID for a scheduled graph before its browser
   * worker is loaded. Existing user/unowned tabs and other graph sessions fail
   * closed, so delegation can never navigate a colliding tab.
   */
  claimOwner(assetId: string, owner: TabOwner): void {
    const existing = this.records.get(assetId);
    if (existing && !this.sameOwner(existing.owner, owner)) {
      throw this.ownershipError(assetId);
    }

    const reserved = this.owners.get(assetId);
    if (reserved && !this.sameOwner(reserved, owner)) {
      throw this.ownershipError(assetId);
    }

    this.owners.set(assetId, { ...owner });
  }

  /** Verify a tab belongs to this exact graph session before any delegation. */
  assertOwner(assetId: string, owner: TabOwner): void {
    const existing = this.records.get(assetId);
    const reserved = this.owners.get(assetId);
    if (!existing || !this.sameOwner(existing.owner, owner) || !this.sameOwner(reserved, owner)) {
      throw this.ownershipError(assetId);
    }
  }

  /** Release a failed pre-open reservation; live tab ownership is never released here. */
  releaseOwnerReservation(assetId: string, owner: TabOwner): void {
    if (this.records.has(assetId)) return;
    const reserved = this.owners.get(assetId);
    if (this.sameOwner(reserved, owner)) this.owners.delete(assetId);
  }

  /** Open or update a tab. Re-entrant: same assetId + URL is a no-op. */
  open(input: { assetId: string; url: string; title?: string; origin?: 'user' | 'agent'; owner?: TabOwner }): TabRecord {
    const reserved = this.owners.get(input.assetId);
    if (reserved && !this.sameOwner(reserved, input.owner)) {
      throw this.ownershipError(input.assetId);
    }

    const existing = this.records.get(input.assetId);
    if (existing) {
      if (!this.sameOwner(existing.owner, input.owner)) {
        throw this.ownershipError(input.assetId);
      }
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
      ...(input.owner ? { owner: { ...input.owner } } : {}),
      createdAt:      Date.now(),
      lastAccessedAt: Date.now(),
    };
    if (input.owner) this.owners.set(input.assetId, { ...input.owner });
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
    this.owners.delete(assetId);
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
