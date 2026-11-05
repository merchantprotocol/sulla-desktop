// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as crypto from 'crypto';

const DEFAULT_TTL_MS = 60_000;

export interface FunctionBrowserAdapter {
  open(assetId: string, url: string): Promise<void>;
  evaluate(assetId: string, code: string): Promise<unknown>;
  close(assetId: string): Promise<void>;
}

interface BrowserCapability {
  invocationId:  string;
  expiresAt:     number;
  allowedOrigins: string[];
  tabs:          Map<string, string>;
}

export type BrowserCapabilityOutcome = 'unknown-token' | 'expired' | 'foreign-tab' | 'origin-not-allowed' | 'invalid-url';

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

  constructor(
    private readonly browser: FunctionBrowserAdapter,
    private readonly now: () => number = Date.now,
    private readonly tokenFactory: () => string = () => crypto.randomBytes(32).toString('base64url'),
  ) {}

  mintForManifest(invocationId: string, manifest: unknown, ttlMs: number = DEFAULT_TTL_MS): { token: string } | null {
    const permission = new FunctionBrowserPermissionReader().read(manifest);
    return permission ? this.mint(invocationId, permission, ttlMs) : null;
  }

  mint(invocationId: string, permission: FunctionBrowserPermission, ttlMs: number = DEFAULT_TTL_MS): { token: string } {
    const token = this.tokenFactory();
    this.capabilities.set(token, {
      invocationId,
      expiresAt: this.now() + ttlMs,
      allowedOrigins: [...permission.allowedOrigins],
      tabs: new Map(),
    });
    return { token };
  }

  async open(token: string, url: string): Promise<{ tabId: string }> {
    const capability = await this.requireCapability(token);
    const parsed = this.validateUrl(url, capability.allowedOrigins);
    const tabId = crypto.randomUUID();
    const assetId = `function_${ capability.invocationId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-40) }_${ tabId }`;
    await this.browser.open(assetId, parsed.toString());
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
    capability.tabs.delete(tabId);
    await this.browser.close(assetId);
  }

  async invalidate(token: string): Promise<void> {
    const capability = this.capabilities.get(token);
    this.capabilities.delete(token);
    if (!capability) return;
    await Promise.allSettled([...capability.tabs.values()].map(assetId => this.browser.close(assetId)));
    capability.tabs.clear();
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

  private validateUrl(raw: string, allowedOrigins: string[]): URL {
    let url: URL;
    try { url = new URL(raw) } catch { throw new FunctionBrowserCapabilityError('invalid-url') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new FunctionBrowserCapabilityError('invalid-url');
    }
    if (allowedOrigins.length > 0 && !allowedOrigins.includes(url.origin)) {
      throw new FunctionBrowserCapabilityError('origin-not-allowed');
    }
    return url;
  }
}
