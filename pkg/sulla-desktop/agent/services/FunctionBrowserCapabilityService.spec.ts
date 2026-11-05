// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import {
  FunctionBrowserCapabilityError,
  FunctionBrowserCapabilityService,
  type FunctionBrowserAdapter,
} from './FunctionBrowserCapabilityService';

class RecordingBrowser implements FunctionBrowserAdapter {
  readonly openTabs = new Set<string>();
  async open(assetId: string): Promise<void> { this.openTabs.add(assetId) }
  async evaluate(_assetId: string, code: string): Promise<unknown> { return { code } }
  async close(assetId: string): Promise<void> { this.openTabs.delete(assetId) }
}

class BrowserHarness {
  readonly browser = new RecordingBrowser();
  now = 1_000;
  tokenNumber = 0;
  readonly service = new FunctionBrowserCapabilityService(
    this.browser,
    () => this.now,
    () => `token-${ ++this.tokenNumber }`,
  );
}

describe('FunctionBrowserCapabilityService', () => {
  it('refuses to mint a capability when browser permission is absent', () => {
    // risk: permission bypass
    const harness = new BrowserHarness();
    const capability = harness.service.mintForManifest('unauthorized', { spec: { permissions: {} } });
    expect(capability).toBeNull();
  });

  it('refuses expired tokens and closes their tabs', async() => {
    // risk: capability replay and leaked browser resources
    const harness = new BrowserHarness();
    const { token } = harness.service.mint('invocation-a', { enabled: true, allowedOrigins: [] }, 10);
    const { tabId } = await harness.service.open(token, 'https://example.com');
    expect(harness.browser.openTabs.size).toBe(1);
    harness.now += 10;
    await expect(harness.service.evaluate(token, tabId, 'document.title'))
      .rejects.toMatchObject<Partial<FunctionBrowserCapabilityError>>({ outcome: 'expired' });
    expect(harness.browser.openTabs.size).toBe(0);
  });

  it('refuses a foreign capability from evaluating another invocation tab', async() => {
    // risk: cross-invocation browser data disclosure
    const harness = new BrowserHarness();
    const first = harness.service.mint('invocation-a', { enabled: true, allowedOrigins: [] });
    const second = harness.service.mint('invocation-b', { enabled: true, allowedOrigins: [] });
    const { tabId } = await harness.service.open(first.token, 'https://example.com');
    await expect(harness.service.evaluate(second.token, tabId, 'document.title'))
      .rejects.toMatchObject<Partial<FunctionBrowserCapabilityError>>({ outcome: 'foreign-tab' });
  });

  it('closes every remaining tab when the invocation ends', async() => {
    // risk: persistent side effects and browser memory leak
    const harness = new BrowserHarness();
    const { token } = harness.service.mint('invocation-a', { enabled: true, allowedOrigins: [] });
    await harness.service.open(token, 'https://example.com/a');
    await harness.service.open(token, 'https://example.com/b');
    expect(harness.browser.openTabs.size).toBe(2);
    await harness.service.invalidate(token);
    expect(harness.browser.openTabs.size).toBe(0);
  });
});
