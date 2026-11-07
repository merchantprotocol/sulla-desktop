// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as crypto from 'crypto';
import { BrowserUrlPolicy } from './BrowserUrlPolicy';

const DEFAULT_TTL_MS = 60_000;
const MAX_TTL_MS = 10 * 60_000;
const TTL_GRACE_MS = 5_000;
const SHUTDOWN_CLEANUP_DEADLINE_MS = 5_000;

export class FunctionBrowserOpenFailedError extends Error {
  constructor(public readonly assetId: string, public readonly originalError: unknown) {
    super('browser open failed and its tab could not be cleaned up', { cause: originalError });
    this.name = 'FunctionBrowserOpenFailedError';
  }
}

export interface FunctionBrowserAdapter {
  open(assetId: string, url: string, validateNavigation: (url: string) => Promise<void>): Promise<void>;
  evaluate(assetId: string, code: string): Promise<unknown>;
  close(assetId: string): Promise<void>;
}

interface BrowserCapability {
  invocationId:  string;
  expiresAt:     number;
  allowedOrigins: string[];
  tabs:          Map<string, string>;
  pendingOpens:  Set<Promise<void>>;
  expiryTimer:   ReturnType<typeof setTimeout>;
  revoked:       boolean;
}

class BrowserTabCleanupRegistry {
  private readonly pending = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly browser: FunctionBrowserAdapter,
    private readonly schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>,
    private readonly cancelSchedule: (timer: ReturnType<typeof setTimeout>) => void,
    private readonly now: () => number,
  ) {}

  retain(assetId: string): void {
    if (this.pending.has(assetId)) return;
    this.pending.set(assetId, 0);
    this.scheduleRetry(assetId);
  }

  get size(): number { return this.pending.size }

  async drain(): Promise<void> {
    for (const timer of this.timers.values()) this.cancelSchedule(timer);
    this.timers.clear();
    const deadline = this.now() + SHUTDOWN_CLEANUP_DEADLINE_MS;
    let attempt = 0;
    while (this.pending.size > 0 && this.now() < deadline) {
      for (const assetId of [...this.pending.keys()]) await this.tryClose(assetId, false);
      if (this.pending.size === 0) return;
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      const delay = Math.min(100 * (2 ** attempt), 5_000, remaining);
      await new Promise<void>(resolve => { this.schedule(resolve, delay) });
      attempt += 1;
    }
    if (this.pending.size > 0) console.error('Browser tab cleanup deadline reached', { assetIds: [...this.pending.keys()] });
  }

  private scheduleRetry(assetId: string): void {
    const attempt = this.pending.get(assetId);
    if (attempt === undefined || this.timers.has(assetId)) return;
    const delay = Math.min(100 * (2 ** attempt), 5_000);
    const timer = this.schedule(() => {
      this.timers.delete(assetId);
      void this.tryClose(assetId, true);
    }, delay);
    this.timers.set(assetId, timer);
  }

  private async tryClose(assetId: string, reschedule: boolean): Promise<void> {
    try {
      await this.browser.close(assetId);
      this.pending.delete(assetId);
    } catch {
      this.pending.set(assetId, (this.pending.get(assetId) ?? 0) + 1);
      if (reschedule) this.scheduleRetry(assetId);
    }
  }
}

export type BrowserCapabilityOutcome = 'unknown-token' | 'expired' | 'foreign-tab' | 'origin-not-allowed' | 'invalid-url' | 'unsafe-network-target';

export class FunctionBrowserCapabilityError extends Error {
  constructor(public readonly outcome: BrowserCapabilityOutcome) {
    super(`browser capability: ${ outcome }`);
    this.name = 'FunctionBrowserCapabilityError';
  }
}

export interface FunctionBrowserPermission {
  enabled:        boolean;
  allowedOrigins: string[];
}

export class FunctionBrowserPermissionReader {
  read(manifest: any): FunctionBrowserPermission | null {
    const declaration = manifest?.spec?.permissions?.browser;
    if (declaration === true) return { enabled: true, allowedOrigins: [] };
    if (!declaration || typeof declaration !== 'object' || declaration.enabled !== true) return null;
    const allowedOrigins = Array.isArray(declaration.allowedOrigins)
      ? declaration.allowedOrigins.filter((value: unknown): value is string => typeof value === 'string')
      : [];
    return { enabled: true, allowedOrigins };
  }
}

export class FunctionBrowserCapabilityService {
  private readonly capabilities = new Map<string, BrowserCapability>();
  private readonly cleanupRegistry: BrowserTabCleanupRegistry;

  constructor(
    private readonly browser: FunctionBrowserAdapter,
    private readonly now: () => number = Date.now,
    private readonly tokenFactory: () => string = () => crypto.randomBytes(32).toString('base64url'),
    private readonly urlPolicy = new BrowserUrlPolicy(),
    private readonly schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> = setTimeout,
    private readonly cancelSchedule: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout,
  ) { this.cleanupRegistry = new BrowserTabCleanupRegistry(browser, schedule, cancelSchedule, now) }

  get pendingCleanupCount(): number { return this.cleanupRegistry.size }

  mintForManifest(invocationId: string, manifest: unknown, ttlMs: number = DEFAULT_TTL_MS): { token: string } | null {
    const permission = new FunctionBrowserPermissionReader().read(manifest);
    return permission ? this.mint(invocationId, permission, ttlMs) : null;
  }

  mint(invocationId: string, permission: FunctionBrowserPermission, ttlMs: number = DEFAULT_TTL_MS): { token: string } {
    const token = this.tokenFactory();
    const boundedTtl = Math.min(Math.max(ttlMs + TTL_GRACE_MS, TTL_GRACE_MS), MAX_TTL_MS);
    const capability: BrowserCapability = {
      invocationId,
      expiresAt: this.now() + boundedTtl,
      allowedOrigins: [...permission.allowedOrigins],
      tabs: new Map(),
      pendingOpens: new Set(),
      expiryTimer: null as unknown as ReturnType<typeof setTimeout>,
      revoked: false,
    };
    capability.expiryTimer = this.schedule(() => { void this.invalidate(token) }, boundedTtl);
    this.capabilities.set(token, capability);
    return { token };
  }

  async open(token: string, url: string): Promise<{ tabId: string }> {
    const capability = await this.requireCapability(token);
    const parsed = await this.validateUrl(url, capability.allowedOrigins);
    const tabId = crypto.randomUUID();
    const assetId = `function_${ capability.invocationId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-40) }_${ tabId }`;
    const pending = this.browser.open(assetId, parsed.toString(), async candidate => { await this.validateUrl(candidate, capability.allowedOrigins) });
    capability.pendingOpens.add(pending);
    try {
      await pending;
    } catch (error) {
      if (error instanceof FunctionBrowserOpenFailedError) {
        try { await this.browser.close(error.assetId) } catch { this.cleanupRegistry.retain(error.assetId) }
        throw error.originalError;
      }
      throw error;
    } finally { capability.pendingOpens.delete(pending) }
    if (capability.revoked || this.capabilities.get(token) !== capability || this.now() >= capability.expiresAt) {
      await this.closeWithRetryRetention(capability, tabId, assetId);
      throw new FunctionBrowserCapabilityError('expired');
    }
    capability.tabs.set(tabId, assetId);
    return { tabId };
  }

  async evaluate(token: string, tabId: string, code: string): Promise<unknown> {
    const capability = await this.requireCapability(token);
    const assetId = capability.tabs.get(tabId);
    if (!assetId) throw new FunctionBrowserCapabilityError('foreign-tab');
    return this.browser.evaluate(assetId, code);
  }

  async close(token: string, tabId: string): Promise<void> {
    const capability = await this.requireCapability(token);
    const assetId = capability.tabs.get(tabId);
    if (!assetId) throw new FunctionBrowserCapabilityError('foreign-tab');
    await this.browser.close(assetId);
    capability.tabs.delete(tabId);
  }

  async invalidate(token: string): Promise<void> {
    const capability = this.capabilities.get(token);
    if (!capability) return;
    capability.revoked = true;
    this.capabilities.delete(token);
    this.cancelSchedule(capability.expiryTimer);
    await Promise.allSettled([...capability.pendingOpens]);
    for (const [tabId, assetId] of [...capability.tabs]) {
      try { await this.browser.close(assetId); capability.tabs.delete(tabId) } catch { this.cleanupRegistry.retain(assetId) }
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.capabilities.keys()].map(token => this.invalidate(token)));
    await this.cleanupRegistry.drain();
  }

  private async requireCapability(token: string): Promise<BrowserCapability> {
    const capability = this.capabilities.get(token);
    if (!capability) throw new FunctionBrowserCapabilityError('unknown-token');
    if (this.now() >= capability.expiresAt) {
      await this.invalidate(token);
      throw new FunctionBrowserCapabilityError('expired');
    }
    return capability;
  }

  private async validateUrl(raw: string, allowedOrigins: string[]): Promise<URL> {
    try { return await this.urlPolicy.validate(raw, allowedOrigins) } catch (error) {
      const outcome = (error as Error).message as BrowserCapabilityOutcome;
      throw new FunctionBrowserCapabilityError(outcome);
    }
  }

  private async closeWithRetryRetention(capability: BrowserCapability, tabId: string, assetId: string): Promise<void> {
    try { await this.browser.close(assetId); capability.tabs.delete(tabId) } catch {
      if (capability.revoked) this.cleanupRegistry.retain(assetId);
      else capability.tabs.set(tabId, assetId);
    }
  }
}
