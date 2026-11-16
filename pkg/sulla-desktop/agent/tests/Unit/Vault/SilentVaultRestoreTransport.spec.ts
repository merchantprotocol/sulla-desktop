// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

import { SilentVaultRestoreTransport } from '../../../../main/silentVaultRestoreTransport';

function response(status: number): Response {
  return new Response(status === 423 ? 'locked' : 'body', { status });
}

describe('SilentVaultRestoreTransport', () => {
  it('passes through responses that are not locked', async() => {
    // risk: availability — a normal response must not trigger a restore or a second call.
    const fetcher = vi.fn(async() => response(200));
    const restore = vi.fn(async() => true);
    const transport = new SilentVaultRestoreTransport(fetcher, restore);

    expect((await transport.fetch('https://vault/x', {})).status).toBe(200);
    expect(restore).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('restores the session once and retries a locked request', async() => {
    // risk: availability — a locked session recovers silently and the request is replayed exactly once.
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(423))
      .mockResolvedValueOnce(response(200));
    const restore = vi.fn(async() => true);
    const transport = new SilentVaultRestoreTransport(fetcher, restore);

    expect((await transport.fetch('https://vault/x', { method: 'POST' })).status).toBe(200);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith('https://vault/x', { method: 'POST' });
  });

  it('returns the locked response when the restore fails', async() => {
    // risk: authorization — a failed restore must not replay a request against a locked vault.
    const fetcher = vi.fn(async() => response(423));
    const transport = new SilentVaultRestoreTransport(fetcher, async() => false);

    expect((await transport.fetch('https://vault/x', {})).status).toBe(423);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('shares one restore between concurrent locked requests', async() => {
    // risk: availability — parallel 423s must not stampede the restore path.
    let release: (value: boolean) => void = () => undefined;
    const restore = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve }));
    const fetcher = vi.fn(async() => response(423));
    const transport = new SilentVaultRestoreTransport(fetcher, restore);

    const first = transport.fetch('https://vault/a', {});
    const second = transport.fetch('https://vault/b', {});
    await vi.waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
    release(false);
    await Promise.all([first, second]);
    expect(restore).toHaveBeenCalledTimes(1);
  });
});
