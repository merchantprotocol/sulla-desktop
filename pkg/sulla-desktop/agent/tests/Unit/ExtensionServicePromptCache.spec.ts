// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExtensionService } from '../../services/ExtensionService';

describe('installed-extension prompt snapshot', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('shares concurrent initialization instead of issuing duplicate extension requests', async () => {
    // risk: fan-out across graph threads multiplies identical extension service reads
    const service = new ExtensionService();
    (service as any).backendUrl = 'http://127.0.0.1:6107';
    vi.spyOn(service as any, 'getRequestHeaders').mockReturnValue({});
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    await Promise.all([service.initialize(), service.initialize(), service.initialize()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds a cold extension fetch and falls back to an empty snapshot on timeout', async () => {
    // risk: a stopped extensions backend must not hold every new graph turn before its first model call
    vi.useFakeTimers();
    const service = new ExtensionService();
    (service as any).backendUrl = 'http://127.0.0.1:6107';
    vi.spyOn(service as any, 'getRequestHeaders').mockReturnValue({});
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })));
    const pending = service.fetchInstalledExtensions();
    await vi.advanceTimersByTimeAsync(3_001);
    await expect(pending).resolves.toEqual([]);
  });

  it('times out marketplace requests, keeps the last good cache, and permits a later retry', async () => {
    // risk: a stalled third-party index must not hang startup extension hydration or discard known-good data
    vi.useFakeTimers();
    const service = new ExtensionService();
    const entry = { slug: 'known-good', version: '1.0', containerd_compatible: true, labels: {}, title: 'Known', logo: '', publisher: 'Sulla', short_description: '' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => 'plugins:\n  - slug: known-good\n    version: "1.0"\n    containerd_compatible: true\n    labels: {}\n    title: Known\n    logo: ""\n    publisher: Sulla\n    short_description: ""\n' })
      .mockImplementation(() => new Promise((_resolve, reject) => {
        // Abort is the observable contract of the bounded fetch.
        const signal = (fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined)?.signal;
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(service.fetchMarketplaceData()).resolves.toEqual([entry]);
    await vi.advanceTimersByTimeAsync(60_001);
    const firstTimedFetch = service.fetchMarketplaceData();
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(firstTimedFetch).resolves.toEqual([entry]);

    const retry = service.fetchMarketplaceData();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(retry).resolves.toEqual([entry]);
  });
});
