// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';

import {
  BrowserPreviewPolicy,
  type BrowserPreviewChatMode,
  type BrowserPreviewExecutionContext,
  type BrowserPreviewNewTabCreation,
  type BrowserPreviewTabVisibility,
} from '@pkg/shared/browserPreviewPolicy';

export type BrowserPreviewGrantHandle = string & { readonly __browserPreviewGrantHandle: unique symbol };

/** The persisted transcript payload is intentionally only an opaque lookup handle. */
export interface BrowserPreviewReferenceEvent {
  readonly kind: 'webpage-preview';
  readonly handle: BrowserPreviewGrantHandle;
}

export interface BrowserPreviewGrantRequest {
  readonly tabId: string;
  readonly threadId: string;
}

export interface BrowserPreviewTabClosedEvent {
  readonly tabId: string;
  readonly generation: string;
}

/** Main-process context source; renderer arguments are never an authority. */
export interface BrowserPreviewExecutionContextAuthority {
  currentExecution(): BrowserPreviewExecutionContext | null;
  /** Fire when auth/visibility is lost, execution ends, or the active context switches away. */
  onExecutionInvalidated(listener: (executionId: string) => void): () => void;
}

/**
 * Main-process tab lifecycle port. consumeNewAgentTabCreation must be one-shot
 * and report only a tab created by this exact agent open operation; it must not
 * infer eligibility from a tab list or renderer-supplied origin flags. It must
 * publish close events for both ordinary close and capacity eviction.
 */
export interface BrowserPreviewTabLifecycleAuthority {
  consumeNewAgentTabCreation(tabId: string): BrowserPreviewNewTabCreation | null;
  onTabClosed(listener: (event: BrowserPreviewTabClosedEvent) => void): () => void;
}

export interface AuthorizedBrowserPreviewTarget {
  readonly tabId: string;
  readonly visibility: BrowserPreviewTabVisibility;
}

interface BrowserPreviewGrantRecord {
  readonly handle: BrowserPreviewGrantHandle;
  readonly tabId: string;
  readonly generation: string;
  readonly threadId: string;
  readonly executionId: string;
  readonly visibility: BrowserPreviewTabVisibility;
}

type HandleFactory = () => string;

/**
 * Owns short-lived read-only preview grants in main-process memory. This class
 * deliberately has no URL, title, favicon, or raster capture API. In particular,
 * it does not prove that a shared signed-in browser session contains only public
 * data; raster capture from such sessions must remain disabled.
 */
export class BrowserPreviewGrantService {
  private readonly grants = new Map<BrowserPreviewGrantHandle, BrowserPreviewGrantRecord>();
  private readonly subscriptions: Array<() => void>;

  constructor(
    private readonly contexts: BrowserPreviewExecutionContextAuthority,
    private readonly tabs: BrowserPreviewTabLifecycleAuthority,
    private readonly makeHandle: HandleFactory = randomUUID,
  ) {
    this.subscriptions = [
      tabs.onTabClosed(event => this.revokeTab(event.tabId, event.generation)),
      contexts.onExecutionInvalidated(executionId => this.revokeExecution(executionId)),
    ];
  }

  /** Called by the trusted main-process new-tab path only; not an IPC handler. */
  createForNewTab(request: BrowserPreviewGrantRequest): BrowserPreviewReferenceEvent | null {
    const context = this.contexts.currentExecution();
    if (!context || !context.threadId || context.threadId !== request.threadId) return null;

    const tab = this.tabs.consumeNewAgentTabCreation(request.tabId);
    if (!BrowserPreviewPolicy.canGrant(context, request.threadId, request.tabId, tab)) return null;
    if ([...this.grants.values()].some(grant => grant.tabId === tab.tabId && grant.generation === tab.generation)) return null;

    const handle = this.nextHandle();
    this.grants.set(handle, {
      handle,
      tabId: tab.tabId,
      generation: tab.generation,
      threadId: context.threadId,
      executionId: context.executionId,
      visibility: tab.visibility,
    });

    // Do not add tabId, threadId, URL, page metadata, or pixels to this event.
    return Object.freeze({ kind: 'webpage-preview', handle });
  }

  /** Re-resolves only an authorized tab identity; callers fetch transient UI props separately. */
  resolve(
    handle: BrowserPreviewGrantHandle,
    request: { readonly threadId: string; readonly mode: BrowserPreviewChatMode },
  ): AuthorizedBrowserPreviewTarget | null {
    const grant = this.grants.get(handle);
    if (!grant) return null;

    const context = this.contexts.currentExecution();
    if (!BrowserPreviewPolicy.canResolve(context, request.threadId, grant.executionId)
      || context?.threadId !== grant.threadId) {
      this.revoke(handle);
      return null;
    }

    if (!BrowserPreviewPolicy.isVisibleInMode(grant.visibility, request.mode)) return null;
    return Object.freeze({ tabId: grant.tabId, visibility: grant.visibility });
  }

  revoke(handle: BrowserPreviewGrantHandle): void {
    this.grants.delete(handle);
  }

  dispose(): void {
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.grants.clear();
  }

  private nextHandle(): BrowserPreviewGrantHandle {
    const value = this.makeHandle();
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(value) || this.grants.has(value as BrowserPreviewGrantHandle)) {
      throw new Error('Browser preview grant handle must be unique and opaque.');
    }
    return value as BrowserPreviewGrantHandle;
  }

  private revokeTab(tabId: string, generation: string): void {
    for (const [handle, grant] of this.grants) {
      if (grant.tabId === tabId && grant.generation === generation) this.grants.delete(handle);
    }
  }

  private revokeExecution(executionId: string): void {
    for (const [handle, grant] of this.grants) {
      if (grant.executionId === executionId) this.grants.delete(handle);
    }
  }
}
