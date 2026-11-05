// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { FunctionBrowserAdapter } from './FunctionBrowserCapabilityService';
import { buildWrapper, classifyCode } from '../tools/browser/exec';
import { getChromeApi } from '@pkg/main/chromeApi';

export class DesktopFunctionBrowserAdapter implements FunctionBrowserAdapter {
  private static capabilityService: import('./FunctionBrowserCapabilityService').FunctionBrowserCapabilityService | null = null;

  static async service(): Promise<import('./FunctionBrowserCapabilityService').FunctionBrowserCapabilityService> {
    if (!this.capabilityService) {
      const { FunctionBrowserCapabilityService } = await import('./FunctionBrowserCapabilityService');
      this.capabilityService = new FunctionBrowserCapabilityService(new DesktopFunctionBrowserAdapter());
    }
    return this.capabilityService;
  }

  async open(assetId: string, url: string): Promise<void> {
    const tab = await getChromeApi().tabs.create({ url, hidden: true });
    this.tabIds.set(assetId, tab.id);
    try {
      const deadline = Date.now() + 30_000;
      while ((await getChromeApi().tabs.get(tab.id))?.status === 'loading') {
        if (Date.now() >= deadline) throw new Error('browser page load timed out');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } catch (error) {
      await this.close(assetId);
      throw error;
    }
  }

  async evaluate(assetId: string, code: string): Promise<unknown> {
    const tabId = this.requireTabId(assetId);
    const classified = classifyCode(code);
    if (classified.form === 'invalid') throw new Error(`invalid browser script: ${ classified.parseError }`);
    const results = await getChromeApi().scripting.executeScript({
      target: { tabId },
      code:   buildWrapper(code, classified.form),
    });
    const envelope: any = results[0]?.result;
    if (envelope?.error) throw new Error(String(envelope.error));
    return envelope?.result;
  }

  async close(assetId: string): Promise<void> {
    const tabId = this.tabIds.get(assetId);
    this.tabIds.delete(assetId);
    if (tabId !== undefined) await getChromeApi().tabs.remove(tabId);
  }

  private readonly tabIds = new Map<string, string>();

  private requireTabId(assetId: string): string {
    const tabId = this.tabIds.get(assetId);
    if (tabId === undefined) throw new Error('browser tab not found');
    return tabId;
  }
}

export function getFunctionBrowserCapabilityService(): Promise<import('./FunctionBrowserCapabilityService').FunctionBrowserCapabilityService> {
  return DesktopFunctionBrowserAdapter.service();
}
