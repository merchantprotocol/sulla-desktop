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
  lastContent:    string;
  lastContentAt:  number;
  unsubs:         (() => void)[];
}

export interface RegistryDomEvent {
  assetId:   string;
  type:      'domChange' | 'dialog' | 'routeChanged' | 'click' | 'pageContent' | 'contentAdded' | 'injected';
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

    unsubs.push(bridge.on('pageContent', (payload) => {
      // Cache the content on the entry
      const entry = this.bridges.get(assetId);
      if (entry) {
        entry.lastContent = payload.content;
        entry.lastContentAt = payload.timestamp;
      }
      // Emit as registry event so it flows to the agent
      const truncNote = payload.truncated ? ' [truncated]' : '';
      this.emitRegistryEvent({
        assetId,
        type:      'pageContent',
        message:   `[CONTENT ${ assetId }] ${ payload.title }${ truncNote }\n${ payload.content }`,
        timestamp: payload.timestamp,
      });
    }));

    unsubs.push(bridge.on('injected', (payload) => {
      this.emitRegistryEvent({
        assetId,
        type:      'injected',
        message:   `[INJECTED ${ assetId }] Bridge ready on ${ payload.url }`,
        timestamp: payload.timestamp,
      });
    }));

    unsubs.push(bridge.on('contentAdded', (payload) => {
      // Append new content to cached content
      const entry = this.bridges.get(assetId);
      if (entry) {
        entry.lastContent = (entry.lastContent + '\n\n' + payload.content).slice(-8000);
        entry.lastContentAt = payload.timestamp;
      }
      this.emitRegistryEvent({
        assetId,
        type:      'contentAdded',
        message:   `[NEW CONTENT ${ assetId }] (${ payload.contentLength } chars added)\n${ payload.content }`,
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
      lastContent:    '',
      lastContentAt:  0,
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
   * Refresh the cached reader content for a single entry.
   * Only fetches if content is stale (older than maxAgeMs).
   * Uses a reduced char limit for system prompt inclusion.
   */
  private async refreshContent(entry: BridgeEntry): Promise<void> {
    if (!entry.bridge.isInjected()) return;
    try {
      const result = await entry.bridge.getReaderContent(8000);
      if (result) {
        entry.lastContent = result.content || '';
        entry.lastContentAt = Date.now();
      }
    } catch {
      // keep stale content on error
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
      // Refresh content with a longer staleness window (30s)
      // since content changes less frequently than interactive elements
      if (now - entry.lastContentAt > 30000) {
        tasks.push(this.refreshContent(entry));
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
    lines.push('### Open Browser Tabs');
    lines.push(`You currently have **${ this.bridges.size } tab(s) open**. Each open tab consumes memory and CPU on the user's machine.`);
    lines.push('');
    lines.push('**Rules:**');
    lines.push('- If you opened a tab and are done with it, close it IMMEDIATELY with `browser_tab(action: \'remove\', assetId: \'...\')`. Do not leave tabs open for later.');
    lines.push('- Before opening a new tab, check if you can reuse an existing one by navigating it to the new URL.');
    lines.push('- Keep no more than 3-5 tabs open at any time. Close finished tabs before opening new ones.');
    lines.push('- When your task is complete, close ALL tabs you opened. Leave zero behind.');
    lines.push('');
    lines.push('Interact with tabs using playwright tools (click_element, set_field, scroll_to_element, get_form_values, get_page_text). Each accepts an `assetId` parameter. DOM changes, navigation, and alerts stream automatically.\n');

    for (const entry of this.bridges.values()) {
      // Skip entries with no URL or about:blank (not real pages)
      if (!entry.url || entry.url === 'about:blank') continue;

      const isActive = entry.assetId === this.activeAssetId;
      const status = entry.bridge.isInjected() ? 'ready' : 'loading';
      const marker = isActive ? ' (active)' : '';

      lines.push(`#### ${ entry.title || entry.assetId }${ marker }`);
      lines.push(`- **assetId**: \`${ entry.assetId }\``);
      lines.push(`- **url**: ${ entry.url }`);
      lines.push(`- **status**: ${ status }`);

      // Scroll position (when available)
      if (entry.bridge.isInjected()) {
        try {
          const scroll = await entry.bridge.getScrollInfo();
          const moreNote = scroll.moreBelow ? ' — more content below' : scroll.atBottom ? ' — at bottom' : '';
          lines.push(`- **scroll**: ${ scroll.percent }% (${ scroll.scrollY }px / ${ scroll.scrollHeight }px)${ moreNote }`);
        } catch { /* skip scroll info on error */ }
      }

      if (entry.lastSnapshot.trim()) {
        lines.push(`\n<page_state asset="${ entry.assetId }">`);
        lines.push(entry.lastSnapshot);
        lines.push('</page_state>');
      }

      if (entry.lastContent.trim()) {
        lines.push(`\n<page_content asset="${ entry.assetId }">`);
        lines.push(entry.lastContent);
        lines.push('</page_content>');
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}

// Singleton instance
export const hostBridgeRegistry = new HostBridgeRegistryImpl();
