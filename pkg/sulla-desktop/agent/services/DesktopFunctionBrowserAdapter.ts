// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import type { FunctionBrowserAdapter } from './FunctionBrowserCapabilityService';
import { buildWrapper, classifyCode } from '../tools/browser/exec';
import { getChromeApi } from '@pkg/main/chromeApi';
const EVALUATION_TIMEOUT_MS = 15_000;
const MAX_RESULT_BYTES = 1024 * 1024;
type ChromeApi = ReturnType<typeof getChromeApi>;
export class DesktopFunctionBrowserAdapter implements FunctionBrowserAdapter {
  private readonly tabIds = new Map<string, string>();
  private readonly navigationGuards = new Map<string, { validate: (url: string) => Promise<void>; listener: (details: { tabId: string; url: string }) => void }>();
  constructor(private readonly chrome: ChromeApi = getChromeApi(), private readonly evaluationTimeoutMs = EVALUATION_TIMEOUT_MS, private readonly maxResultBytes = MAX_RESULT_BYTES) {}
  async open(assetId: string, url: string, validateNavigation: (url: string) => Promise<void>): Promise<void> {
    const tab = await this.chrome.tabs.create({ url, hidden: true, requestGuard: validateNavigation, denyPopups: true }); this.tabIds.set(assetId, tab.id);
    let violation: Error | null = null;
    const onNavigation = (details: { tabId: string; url: string }) => { if (details.tabId === tab.id) void validateNavigation(details.url).catch(error => { violation = error as Error; void this.close(assetId).catch(() => undefined) }) };
    this.chrome.webNavigation.onBeforeNavigate.addListener(onNavigation); this.chrome.webNavigation.onCommitted.addListener(onNavigation);
    this.navigationGuards.set(assetId, { validate: validateNavigation, listener: onNavigation });
    try {
      const deadline = Date.now() + 30_000;
      while (true) {
        if (violation) throw violation;
        const current = await this.chrome.tabs.get(tab.id); if (!current) throw new Error('browser tab closed during navigation');
        if (current.url) await validateNavigation(current.url);
        if (current.status !== 'loading') break;
        if (Date.now() >= deadline) throw new Error('browser page load timed out');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const finalTab = await this.chrome.tabs.get(tab.id); if (!finalTab?.url) throw new Error('browser final URL unavailable');
      await validateNavigation(finalTab.url); if (violation) throw violation;
    } catch (error) { await this.close(assetId).catch(() => undefined); throw error }
  }
  async evaluate(assetId: string, code: string): Promise<unknown> {
    const tabId = this.requireTabId(assetId); const classified = classifyCode(code);
    if (classified.form === 'invalid') throw new Error('invalid browser script');
    const current = await this.chrome.tabs.get(tabId);
    const guard = this.navigationGuards.get(assetId);
    try {
      if (!current?.url || !guard) throw new Error('browser final URL unavailable');
      await guard.validate(current.url);
    } catch (error) {
      await this.close(assetId).catch(() => undefined);
      throw error;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('browser evaluation timed out')), this.evaluationTimeoutMs) });
    try {
      const results = await Promise.race([this.chrome.scripting.executeScript({ target: { tabId }, code: buildWrapper(code, classified.form) }), timeout]);
      const envelope: any = results[0]?.result; if (envelope?.error) throw new Error('browser script failed');
      let serialized: string | undefined; try { serialized = JSON.stringify(envelope?.result) } catch { throw new Error('browser result is not JSON-serializable') }
      if (serialized === undefined) throw new Error('browser result is not JSON-serializable');
      if (Buffer.byteLength(serialized) > this.maxResultBytes) throw new Error('browser result exceeds size limit');
      return JSON.parse(serialized);
    } catch (error) { if ((error as Error).message === 'browser evaluation timed out') await this.close(assetId).catch(() => undefined); throw error } finally { if (timer) clearTimeout(timer) }
  }
  async close(assetId: string): Promise<void> {
    const tabId = this.tabIds.get(assetId); if (tabId === undefined) return;
    const guard = this.navigationGuards.get(assetId);
    if (guard) {
      this.chrome.webNavigation.onBeforeNavigate.removeListener(guard.listener);
      this.chrome.webNavigation.onCommitted.removeListener(guard.listener);
      this.navigationGuards.delete(assetId);
    }
    try { await this.chrome.tabs.remove(tabId); this.tabIds.delete(assetId) } catch (error) {
      const existing = await this.chrome.tabs.get(tabId).catch(() => null); if (!existing) { this.tabIds.delete(assetId); return } throw error;
    }
  }
  private requireTabId(assetId: string): string { const tabId = this.tabIds.get(assetId); if (tabId === undefined) throw new Error('browser tab not found'); return tabId }
}
