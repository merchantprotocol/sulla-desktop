// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { BrowserPreviewPolicy, type BrowserPreviewExecutionContext, type BrowserPreviewNewTabCreation } from '../../../../shared/browserPreviewPolicy';
import {
  BrowserPreviewGrantService,
  type BrowserPreviewExecutionContextAuthority,
  type BrowserPreviewTabClosedEvent,
  type BrowserPreviewTabLifecycleAuthority,
} from '../../../../main/browserPreview/BrowserPreviewGrantService';

const SYNTHETIC_CONTEXT: BrowserPreviewExecutionContext = {
  authenticated: true,
  principal: 'agent',
  surface: 'human-visible-chat',
  threadId: 'synthetic-chat-thread',
  executionId: 'synthetic-chat-execution',
};

const SYNTHETIC_CARD = {
  title: 'Synthetic catalog preview',
  safeAddress: 'https://preview.example.invalid/catalog',
  visibility: 'visible' as const,
  state: 'live' as const,
  rasterDataUrl: 'data:image/png;base64,AA==',
};

function tabCreation(overrides: Partial<BrowserPreviewNewTabCreation> = {}): BrowserPreviewNewTabCreation {
  return {
    tabId: 'synthetic-preview-tab',
    generation: 'synthetic-tab-generation-1',
    origin: 'agent',
    ownerKind: 'human-visible-chat',
    threadId: SYNTHETIC_CONTEXT.threadId,
    executionId: SYNTHETIC_CONTEXT.executionId,
    visibility: 'hidden',
    ...overrides,
  };
}

class FakeContextAuthority implements BrowserPreviewExecutionContextAuthority {
  current: BrowserPreviewExecutionContext | null = SYNTHETIC_CONTEXT;
  private readonly invalidationListeners = new Set<(executionId: string) => void>();

  currentExecution(): BrowserPreviewExecutionContext | null { return this.current; }

  onExecutionInvalidated(listener: (executionId: string) => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  invalidate(executionId: string): void {
    for (const listener of this.invalidationListeners) listener(executionId);
  }
}

class FakeTabLifecycleAuthority implements BrowserPreviewTabLifecycleAuthority {
  private readonly newTabs = new Map<string, BrowserPreviewNewTabCreation>();
  private readonly closeListeners = new Set<(event: BrowserPreviewTabClosedEvent) => void>();

  registerNewTab(tab: BrowserPreviewNewTabCreation): void { this.newTabs.set(tab.tabId, tab); }

  consumeNewAgentTabCreation(tabId: string): BrowserPreviewNewTabCreation | null {
    const tab = this.newTabs.get(tabId) ?? null;
    if (tab) this.newTabs.delete(tabId);
    return tab;
  }

  onTabClosed(listener: (event: BrowserPreviewTabClosedEvent) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  closeOrEvict(tabId: string, generation: string): void {
    for (const listener of this.closeListeners) listener({ tabId, generation });
  }
}

function fixture(creation: BrowserPreviewNewTabCreation | null = tabCreation()) {
  const contexts = new FakeContextAuthority();
  const tabs = new FakeTabLifecycleAuthority();
  if (creation) tabs.registerNewTab(creation);
  let handleCounter = 0;
  const service = new BrowserPreviewGrantService(contexts, tabs, () => `synthetic-opaque-preview-handle-${String(++handleCounter).padStart(2, '0')}`);
  return { contexts, tabs, service };
}

describe('BrowserPreviewGrantService', () => {
  it('persists only an opaque handle for a newly created, matching chat tab', () => { // risk: webpage metadata or session data leaks through transcript persistence
    const { service } = fixture();
    const event = service.createForNewTab({ tabId: 'synthetic-preview-tab', threadId: SYNTHETIC_CONTEXT.threadId });

    expect(event).toEqual({ kind: 'webpage-preview', handle: 'synthetic-opaque-preview-handle-01' });
    expect(Object.keys(event ?? {})).toEqual(['kind', 'handle']);
    expect(JSON.stringify(event)).not.toContain(SYNTHETIC_CARD.safeAddress);
    expect(JSON.stringify(event)).not.toContain(SYNTHETIC_CARD.title);
    expect(JSON.stringify(event)).not.toContain('rasterDataUrl');
  });

  it.each([
    ['unauthenticated execution', { ...SYNTHETIC_CONTEXT, authenticated: false }, tabCreation()],
    ['user principal', { ...SYNTHETIC_CONTEXT, principal: 'user' as const }, tabCreation()],
    ['graph surface', { ...SYNTHETIC_CONTEXT, surface: 'graph' as const }, tabCreation()],
    ['graph execution marker', { ...SYNTHETIC_CONTEXT, graphExecutionId: 'synthetic-graph' }, tabCreation()],
    ['user-owned tab', SYNTHETIC_CONTEXT, tabCreation({ origin: 'user', ownerKind: 'user' })],
    ['graph-owned tab', SYNTHETIC_CONTEXT, tabCreation({ ownerKind: 'graph' })],
    ['different thread', SYNTHETIC_CONTEXT, tabCreation({ threadId: 'other-thread' })],
    ['different execution', SYNTHETIC_CONTEXT, tabCreation({ executionId: 'other-execution' })],
    ['creation proof for another tab id', SYNTHETIC_CONTEXT, tabCreation({ tabId: 'other-tab' })],
  ])('denies %s', (_name, context, creation) => { // risk: unauthorized tab disclosure across user, graph, or thread boundaries
    const { contexts, service } = fixture(creation);
    contexts.current = context;
    expect(service.createForNewTab({ tabId: 'synthetic-preview-tab', threadId: SYNTHETIC_CONTEXT.threadId })).toBeNull();
  });

  it('denies pre-existing tabs because they have no one-shot creation proof', () => { // risk: granting access to an existing signed-in user tab
    const { service } = fixture(null);
    expect(service.createForNewTab({ tabId: 'synthetic-preview-tab', threadId: SYNTHETIC_CONTEXT.threadId })).toBeNull();
  });

  it('does not consume a valid tab proof for a request from another chat thread', () => { // risk: cross-thread preview access from forged event context
    const { service } = fixture();
    expect(service.createForNewTab({ tabId: 'synthetic-preview-tab', threadId: 'different-thread' })).toBeNull();
    expect(service.createForNewTab({ tabId: 'synthetic-preview-tab', threadId: SYNTHETIC_CONTEXT.threadId })).not.toBeNull();
  });

  it('rejects replay of a one-shot proof for the same tab generation', () => { // risk: duplicate grant creation from a replayed tab-created event
    const { service, tabs } = fixture();
    expect(service.createForNewTab({ tabId: 'synthetic-preview-tab', threadId: SYNTHETIC_CONTEXT.threadId })).not.toBeNull();
    tabs.registerNewTab(tabCreation());
    expect(service.createForNewTab({ tabId: 'synthetic-preview-tab', threadId: SYNTHETIC_CONTEXT.threadId })).toBeNull();
  });

  it('keeps hidden previews out of Standard and exposes them only in Detailed', () => { // risk: hidden browsing activity shown in the wrong mode
    const { service } = fixture(tabCreation({ visibility: 'hidden' }));
    const event = service.createForNewTab({ tabId: 'synthetic-preview-tab', threadId: SYNTHETIC_CONTEXT.threadId })!;

    expect(service.resolve(event.handle, { threadId: SYNTHETIC_CONTEXT.threadId, mode: 'standard' })).toBeNull();
    expect(service.resolve(event.handle, { threadId: SYNTHETIC_CONTEXT.threadId, mode: 'detailed' })).toEqual({
      tabId: 'synthetic-preview-tab',
      visibility: 'hidden',
    });
    expect(service.resolve(event.handle, { threadId: SYNTHETIC_CONTEXT.threadId, mode: 'standard' })).toBeNull();
  });

  it('allows visible-tab previews in both modes', () => { // risk: visible browser work omitted from the expected Standard transcript
    const { service } = fixture(tabCreation({ visibility: 'visible' }));
    const event = service.createForNewTab({ tabId: 'synthetic-preview-tab', threadId: SYNTHETIC_CONTEXT.threadId })!;

    for (const mode of ['standard', 'detailed'] as const) {
      expect(service.resolve(event.handle, { threadId: SYNTHETIC_CONTEXT.threadId, mode })).toEqual({
        tabId: 'synthetic-preview-tab',
        visibility: 'visible',
      });
    }
  });

  it('revokes on tab close or capacity eviction and matches the tab generation', () => { // risk: stale grants surviving tab closure or evicting a newer tab
    const { service, tabs } = fixture();
    const old = service.createForNewTab({ tabId: 'synthetic-preview-tab', threadId: SYNTHETIC_CONTEXT.threadId })!;
    tabs.registerNewTab(tabCreation({ generation: 'synthetic-tab-generation-2' }));
    const current = service.createForNewTab({ tabId: 'synthetic-preview-tab', threadId: SYNTHETIC_CONTEXT.threadId })!;

    tabs.closeOrEvict('synthetic-preview-tab', 'synthetic-tab-generation-1');
    expect(service.resolve(old.handle, { threadId: SYNTHETIC_CONTEXT.threadId, mode: 'detailed' })).toBeNull();
    expect(service.resolve(current.handle, { threadId: SYNTHETIC_CONTEXT.threadId, mode: 'detailed' })).not.toBeNull();
  });

  it('revokes grants when their authenticated execution context ends', () => { // risk: grant outliving its authorized chat execution
    const { contexts, service } = fixture();
    const event = service.createForNewTab({ tabId: 'synthetic-preview-tab', threadId: SYNTHETIC_CONTEXT.threadId })!;
    contexts.invalidate(SYNTHETIC_CONTEXT.executionId);

    expect(service.resolve(event.handle, { threadId: SYNTHETIC_CONTEXT.threadId, mode: 'detailed' })).toBeNull();
  });

  it('invalidates a handle when the current context no longer matches, even without an end event', () => { // risk: context-switch race retaining cross-thread authority
    const { contexts, service } = fixture();
    const event = service.createForNewTab({ tabId: 'synthetic-preview-tab', threadId: SYNTHETIC_CONTEXT.threadId })!;
    contexts.current = { ...SYNTHETIC_CONTEXT, threadId: 'another-thread', executionId: 'another-execution' };

    expect(service.resolve(event.handle, { threadId: SYNTHETIC_CONTEXT.threadId, mode: 'detailed' })).toBeNull();
    contexts.current = SYNTHETIC_CONTEXT;
    expect(service.resolve(event.handle, { threadId: SYNTHETIC_CONTEXT.threadId, mode: 'detailed' })).toBeNull();
  });

  it('unsubscribes lifecycle listeners and clears grants on dispose', () => {
    const { service, tabs } = fixture();
    const event = service.createForNewTab({ tabId: 'synthetic-preview-tab', threadId: SYNTHETIC_CONTEXT.threadId })!;
    service.dispose();
    tabs.closeOrEvict('synthetic-preview-tab', 'synthetic-tab-generation-1');

    expect(service.resolve(event.handle, { threadId: SYNTHETIC_CONTEXT.threadId, mode: 'detailed' })).toBeNull();
  });
});

describe('BrowserPreviewPolicy', () => {
  it('shows hidden tabs only in Detailed and visible tabs in both modes', () => { // risk: mode policy diverging between Standard and Detailed
    expect(BrowserPreviewPolicy.modesFor('hidden')).toEqual(['detailed']);
    expect(BrowserPreviewPolicy.modesFor('visible')).toEqual(['standard', 'detailed']);
    expect(BrowserPreviewPolicy.isVisibleInMode('hidden', 'standard')).toBe(false);
    expect(BrowserPreviewPolicy.isVisibleInMode('hidden', 'detailed')).toBe(true);
    expect(BrowserPreviewPolicy.isVisibleInMode('visible', 'standard')).toBe(true);
    expect(BrowserPreviewPolicy.isVisibleInMode('visible', 'detailed')).toBe(true);
  });

  it('accepts only bounded inline raster data, never a site URL or SVG', () => { // risk: card executing remote site code or leaking cookies via an iframe
    expect(BrowserPreviewPolicy.safeRasterSource(SYNTHETIC_CARD.rasterDataUrl)).toBe(SYNTHETIC_CARD.rasterDataUrl);
    expect(BrowserPreviewPolicy.safeRasterSource('https://preview.example.invalid/page')).toBeNull();
    expect(BrowserPreviewPolicy.safeRasterSource('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(BrowserPreviewPolicy.safeRasterSource(`data:image/png;base64,${ 'A'.repeat(5_600_001) }`)).toBeNull();
  });
});
