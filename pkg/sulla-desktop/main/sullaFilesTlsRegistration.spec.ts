// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { desktopFilesTransport } from '../agent/files/desktopFilesTransport';
import { loopbackOrigin } from '@pkg/utils/instance';

import { desktopFilesFetch, FILES_HTTPS_ORIGIN, SullaFilesSessionPool } from './sullaFilesTls';

vi.mock('electron', () => ({ session: { fromPartition: () => ({}) } }));
vi.mock('@pkg/utils/logging', () => ({ default: {} }));
vi.mock('@pkg/utils/paths', () => ({ default: { appHome: '/tmp/sulla-files-registration-spec' } }));
vi.mock('./vaultTlsVerifier', () => ({ verifyVaultCertificate: vi.fn() }));

describe('Desktop main Files transport registration', () => {
  it('registers the pinned-TLS transport on import so agent-side Files calls resolve it in Desktop main', () => {
    // risk: if registration never runs, every Desktop-origin Files call fails with "transport is not available".
    const transport = desktopFilesTransport.resolve();
    expect(transport.origin).toBe(loopbackOrigin('https', 30124));
    expect(transport.origin).toBe(FILES_HTTPS_ORIGIN);
    expect(transport.fetch).toBe(desktopFilesFetch);
  });

  it('is imported by the Electron main entry before any agent code loads', () => {
    // risk: a lazy or indirect-only load leaves the transport unregistered until some other module happens to import it.
    const entry = readFileSync(new URL('../../../background.ts', import.meta.url), 'utf8');
    expect(entry).toContain("import '@pkg/main/sullaFilesTls';");
  });
});

describe('SullaFilesSessionPool recovery', () => {
  it('resets a pinned session after a hung idempotent request and retries once', async() => {
    // risk: availability — a stale Chromium keep-alive socket must not strand the next Files request.
    const session = {
      fetch: vi.fn()
        .mockImplementationOnce((_input:string, init?:RequestInit) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }))
        .mockResolvedValueOnce(new Response('ok')),
      closeAllConnections: vi.fn().mockResolvedValue(undefined),
    };
    const onReset = vi.fn();
    const pool = new SullaFilesSessionPool(async() => session, onReset, 250);

    const response = await pool.fetch('https://127.0.0.1:30124/v1/local/identity', {
      signal: AbortSignal.timeout(20),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(session.fetch).toHaveBeenCalledTimes(2);
    expect(session.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('clears the pinned pool and retries once after Chromium reports a network change', async() => {
    // risk: availability — ERR_NETWORK_CHANGED must evict the broken per-host connections before the next GET.
    const session = {
      fetch: vi.fn()
        .mockRejectedValueOnce(new TypeError('net::ERR_NETWORK_CHANGED'))
        .mockResolvedValueOnce(new Response('ok')),
      closeAllConnections: vi.fn().mockResolvedValue(undefined),
    };
    const onReset = vi.fn();
    const pool = new SullaFilesSessionPool(async() => session, onReset, 250);

    await expect(pool.fetch('https://127.0.0.1:30124/v1/files')).resolves.toHaveProperty('status', 200);
    expect(session.fetch).toHaveBeenCalledTimes(2);
    expect(session.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('does not retry a write whose receipt is unknown', async() => {
    // risk: irreversible side effects — a timed-out write may already have been applied by Files.
    const session = {
      fetch: vi.fn().mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      closeAllConnections: vi.fn(),
    };
    const onReset = vi.fn();
    const pool = new SullaFilesSessionPool(async() => session, onReset, 20);

    await expect(pool.fetch('https://127.0.0.1:30124/v1/files/write', { method: 'POST' })).rejects.toThrow('timeout');
    expect(session.fetch).toHaveBeenCalledTimes(1);
    expect(session.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
