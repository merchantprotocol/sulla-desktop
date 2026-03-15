/**
 * HostBridgeRegistry.ts
 *
 * Multi-asset bridge registry.  Each open website iframe asset registers its
 * WebviewHostBridge here keyed by `assetId`.  Tools resolve a bridge by
 * optional assetId — or fall back to the "active" one.
 *
 * The Vue layer calls:
 *   registerBridge(assetId, bridge)   — on attach
 *   setActiveBridge(assetId)          — when the asset becomes the focused tab
 *   unregisterBridge(assetId)         — on detach / unmount
 */

import type { WebviewHostBridge } from './WebviewHostBridge';

export interface BridgeEntry {
  assetId:        string;
  bridge:         WebviewHostBridge;
  title:          string;
  url:            string;
  registeredAt:   number;
  lastSnapshot:   string;
  lastSnapshotAt: number;
  unsubs:         (() => void)[];
}

export interface RegistryDomEvent {
  assetId:   string;
  type:      'domChange' | 'dialog' | 'routeChanged' | 'click';
  message:   string;
  timestamp: number;
}

type RegistryEventHandler = (event: RegistryDomEvent) => void;

class HostBridgeRegistryImpl {
  private bridges = new Map<string, BridgeEntry>();
  private activeAssetId: string | null = null;
  private eventHandlers = new Set<RegistryEventHandler>();

  /* ------------------------------------------------------------------ */
  /*  Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  registerBridge(assetId: string, bridge: WebviewHostBridge, meta?: { title?: string; url?: string }): void {
    // Unregister first if already exists
    if (this.bridges.has(assetId)) {
      this.unregisterBridge(assetId);
    }

    const unsubs: (() => void)[] = [];

    // Auto-subscribe to bridge events and forward as RegistryDomEvents
    unsubs.push(bridge.on('domChange', (payload) => {
      this.emitRegistryEvent({
        assetId,
        type:      'domChange',
        message:   `[DOM ${ assetId }] ${ payload.summary }`,
        timestamp: payload.timestamp,
      });
    }));

    unsubs.push(bridge.on('dialog', (payload) => {
      const extra = payload.defaultValue ? ` (default: "${ payload.defaultValue }")` : '';
      this.emitRegistryEvent({
        assetId,
        type:      'dialog',
        message:   `[DIALOG ${ assetId }] ${ payload.dialogType }: ${ payload.message }${ extra }`,
        timestamp: payload.timestamp,
      });
    }));

    unsubs.push(bridge.on('routeChanged', (payload) => {
      this.emitRegistryEvent({
        assetId,
        type:      'routeChanged',
        message:   `[NAV ${ assetId }] Navigated to ${ payload.path } — "${ payload.title }"`,
        timestamp: payload.timestamp,
      });
    }));

    unsubs.push(bridge.on('click', (payload) => {
      const handle = payload.dataTestId || payload.id || payload.text.slice(0, 40);
      this.emitRegistryEvent({
        assetId,
        type:      'click',
        message:   `[CLICK ${ assetId }] ${ payload.tagName.toLowerCase() } "${ handle }"`,
        timestamp: payload.timestamp,
      });
    }));

    this.bridges.set(assetId, {
      assetId,
      bridge,
      title:          meta?.title ?? '',
      url:            meta?.url ?? '',
      registeredAt:   Date.now(),
      lastSnapshot:   '',
      lastSnapshotAt: 0,
      unsubs,
    });

    // First registered bridge becomes active by default
    if (!this.activeAssetId) {
      this.activeAssetId = assetId;
    }
  }

  unregisterBridge(assetId: string): void {
    const entry = this.bridges.get(assetId);
    if (entry) {
      for (const unsub of entry.unsubs) {
        try { unsub() } catch { /* no-op */ }
      }
    }
    this.bridges.delete(assetId);
    if (this.activeAssetId === assetId) {
      // Promote next available bridge, or null
      const next = this.bridges.keys().next();
      this.activeAssetId = next.done ? null : next.value;
    }
  }

  setActiveBridge(assetId: string): void {
    if (this.bridges.has(assetId)) {
      this.activeAssetId = assetId;
    }
  }

  updateMeta(assetId: string, meta: { title?: string; url?: string }): void {
    const entry = this.bridges.get(assetId);
    if (!entry) return;
    if (meta.title !== undefined) entry.title = meta.title;
    if (meta.url !== undefined) entry.url = meta.url;
  }

  /* ------------------------------------------------------------------ */
  /*  Lookups                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Resolve a bridge by assetId.  When assetId is omitted or empty,
   * returns the currently active bridge.
   */
  resolve(assetId?: string): WebviewHostBridge | null {
    if (assetId) {
      return this.bridges.get(assetId)?.bridge ?? null;
    }
    if (this.activeAssetId) {
      return this.bridges.get(this.activeAssetId)?.bridge ?? null;
    }
    return null;
  }

  getActiveAssetId(): string | null {
    return this.activeAssetId;
  }

  getEntry(assetId: string): BridgeEntry | null {
    return this.bridges.get(assetId) ?? null;
  }

  getAllEntries(): BridgeEntry[] {
    return Array.from(this.bridges.values());
  }

  size(): number {
    return this.bridges.size;
  }

  clear(): void {
    for (const entry of this.bridges.values()) {
      for (const unsub of entry.unsubs) {
        try { unsub() } catch { /* no-op */ }
      }
    }
    this.bridges.clear();
    this.activeAssetId = null;
  }

  /* ------------------------------------------------------------------ */
  /*  Registry-level event system (consumed by ActionNode)               */
  /* ------------------------------------------------------------------ */

  /**
   * Subscribe to all bridge events across all registered assets.
   * Returns an unsubscribe function.
   */
  onDomEvent(handler: RegistryEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => { this.eventHandlers.delete(handler) };
  }

  private emitRegistryEvent(event: RegistryDomEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.error('[HostBridgeRegistry] event handler error', error);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Snapshot refresh + system prompt context                           */
  /* ------------------------------------------------------------------ */

  /**
   * Refresh the cached snapshot for a single entry.
   * Called lazily before building the system prompt context.
   */
  private async refreshSnapshot(entry: BridgeEntry): Promise<void> {
    if (!entry.bridge.isInjected()) return;
    try {
      const markdown = await entry.bridge.getActionableMarkdown();
      entry.lastSnapshot = markdown || '';
      entry.lastSnapshotAt = Date.now();
    } catch {
      // keep stale snapshot on error
    }
  }

  /**
   * Refresh snapshots for all registered bridges.
   * Snapshots older than `maxAgeMs` are re-fetched.
   */
  async refreshAllSnapshots(maxAgeMs = 5000): Promise<void> {
    const now = Date.now();
    const tasks: Promise<void>[] = [];
    for (const entry of this.bridges.values()) {
      if (now - entry.lastSnapshotAt > maxAgeMs) {
        tasks.push(this.refreshSnapshot(entry));
      }
    }
    await Promise.all(tasks);
  }

  /**
   * Build a Markdown block describing all open website assets and their
   * current page state.  Designed to be injected into the system prompt
   * so the model knows what it can interact with.
   *
   * Returns empty string when no assets are open.
   */
  async getSystemPromptContext(maxAgeMs = 5000): Promise<string> {
    if (this.bridges.size === 0) return '';

    await this.refreshAllSnapshots(maxAgeMs);

    const lines: string[] = [];
    lines.push('### Active Website Assets');
    lines.push(`You have ${ this.bridges.size } website(s) open that you can interact with using the playwright tools (click_element, set_field, scroll_to_element, get_form_values, get_page_text). Each tool accepts an optional assetId parameter to target a specific website. DOM changes, navigation, clicks, and dialog alerts are streamed to you automatically — you do NOT need to poll for page state.\n`);

    for (const entry of this.bridges.values()) {
      const isActive = entry.assetId === this.activeAssetId;
      const status = entry.bridge.isInjected() ? 'ready' : 'loading';
      const marker = isActive ? ' (active)' : '';

      lines.push(`#### ${ entry.title || entry.assetId }${ marker }`);
      lines.push(`- **assetId**: \`${ entry.assetId }\``);
      lines.push(`- **url**: ${ entry.url }`);
      lines.push(`- **status**: ${ status }`);

      if (entry.lastSnapshot.trim()) {
        lines.push(`\n<page_state asset="${ entry.assetId }">`);
        lines.push(entry.lastSnapshot);
        lines.push('</page_state>');
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}

// Singleton instance
export const hostBridgeRegistry = new HostBridgeRegistryImpl();
