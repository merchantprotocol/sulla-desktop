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
});
