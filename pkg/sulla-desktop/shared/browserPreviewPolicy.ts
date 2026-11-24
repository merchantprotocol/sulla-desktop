// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** The chat presentation mode is deliberately independent of browser tab visibility. */
export type BrowserPreviewChatMode = 'standard' | 'detailed';
export type BrowserPreviewTabVisibility = 'hidden' | 'visible';

/**
 * This value must come from a main-process authentication/context authority. It is
 * never accepted from renderer payloads or persisted preview events.
 */
export interface BrowserPreviewExecutionContext {
  readonly authenticated: boolean;
  readonly principal: 'agent' | 'user';
  readonly surface: 'human-visible-chat' | 'graph' | 'other';
  readonly threadId: string;
  readonly executionId: string;
  readonly graphExecutionId?: string | null;
}

/**
 * A one-shot proof from the main-process tab creation path. The authority that
 * implements consumeNewAgentTabCreation must return null for pre-existing tabs,
 * user tabs, graph-owned tabs, and IDs not created by this exact open operation.
 */
export interface BrowserPreviewNewTabCreation {
  readonly tabId: string;
  readonly generation: string;
  readonly origin: 'agent' | 'user';
  readonly ownerKind: 'human-visible-chat' | 'graph' | 'user' | 'unknown';
  readonly threadId: string;
  readonly executionId: string;
  readonly visibility: BrowserPreviewTabVisibility;
}

export interface EphemeralBrowserPreviewCardSnapshot {
  /** Sanitized display-only text. This value is not persisted with the grant event. */
  readonly title: string;
  /** Sanitized display-only address; callers must omit credentials and query data. */
  readonly safeAddress: string;
  readonly visibility: BrowserPreviewTabVisibility;
  readonly state: 'live' | 'closed' | 'placeholder';
  /** A transient, authorized raster only. This is never stored by the grant service. */
  readonly rasterDataUrl?: string | null;
}

/** Pure authorization/presentation rules shared by the main process and card shell. */
export class BrowserPreviewPolicy {
  static canGrant(
    context: BrowserPreviewExecutionContext | null,
    requestedThreadId: string,
    requestedTabId: string,
    tab: BrowserPreviewNewTabCreation | null,
  ): tab is BrowserPreviewNewTabCreation {
    if (!context || !tab) return false;
    if (context.authenticated !== true || context.principal !== 'agent') return false;
    if (context.surface !== 'human-visible-chat' || context.graphExecutionId) return false;
    if (!context.threadId || !context.executionId || context.threadId !== requestedThreadId) return false;
    if (tab.origin !== 'agent' || tab.ownerKind !== 'human-visible-chat') return false;
    if (!tab.tabId || tab.tabId !== requestedTabId || !tab.generation || tab.threadId !== context.threadId) return false;
    if (tab.executionId !== context.executionId) return false;
    return tab.visibility === 'hidden' || tab.visibility === 'visible';
  }

  static canResolve(
    context: BrowserPreviewExecutionContext | null,
    requestedThreadId: string,
    executionId: string,
  ): boolean {
    return !!context
      && context.authenticated === true
      && context.principal === 'agent'
      && context.surface === 'human-visible-chat'
      && !context.graphExecutionId
      && context.threadId === requestedThreadId
      && context.executionId === executionId;
  }

  static isVisibleInMode(visibility: BrowserPreviewTabVisibility, mode: BrowserPreviewChatMode): boolean {
    if (visibility !== 'hidden' && visibility !== 'visible') return false;
    if (mode !== 'standard' && mode !== 'detailed') return false;
    return visibility === 'visible' || mode === 'detailed';
  }

  static modesFor(visibility: BrowserPreviewTabVisibility): readonly BrowserPreviewChatMode[] {
    if (visibility !== 'hidden' && visibility !== 'visible') return [];
    return visibility === 'hidden' ? ['detailed'] : ['standard', 'detailed'];
  }

  /** Allow only local raster data; never accept a site URL, SVG, or executable source. */
  static safeRasterSource(value: string | null | undefined): string | null {
    if (!value || value.length > 5_600_000) return null;
    return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null;
  }
}
