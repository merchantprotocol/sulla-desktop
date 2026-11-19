// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

vi.mock('./sullaFilesWatcher', () => ({ getSullaFilesWatcher: vi.fn() }));

import { SullaFilesIpcSharingHandlers } from './SullaFilesIpcSharingHandlers';
import { FilesApiError } from './sullaFilesClient';

/** Builds the handlers with a fake Files API that answers each endpoint from `routes`. */
function harness(routes:Record<string, () => Promise<unknown>>) {
  const api = { json: vi.fn((endpoint:string) => (routes[endpoint] ?? (() => Promise.reject(new Error(`unexpected ${ endpoint }`))))()) };
  const services = { watcher: () => ({ status: async() => ({ serverConfigured: true, state: 'ready' }) }), linkService: vi.fn() };
  const upload = { cloudFilesAvailable: async() => true };
  const handlers = new Map<string, (...args:unknown[]) => Promise<unknown>>();
  const ipc = { handle: (channel:string, fn:(...args:unknown[]) => Promise<unknown>) => handlers.set(channel, fn) };
  const sharing = new SullaFilesIpcSharingHandlers(api as any, services as any, upload as any);
  sharing.register(ipc as any);

  return { sharing, handlers, api };
}

describe('SullaFilesIpcSharingHandlers 404 mapping', () => {
  // risk: a missing residency route on an unconfigured install must not read as a broken Files service
  it('reports a 404 from residency-capabilities as not configured on this install', async() => {
    const { sharing } = harness({
      '/v1/residency-capabilities': async() => { throw new FilesApiError('Files request failed (404)', 404) },
    });

    const capabilities = await sharing.capabilities();

    expect(capabilities.onlineOnly).toBe(false);
    expect(capabilities.onlineOnlyReason).toBe('Not configured on this install');
  });

  it('keeps other residency failures visible instead of hiding them as not configured', async() => {
    const { sharing } = harness({
      '/v1/residency-capabilities': async() => { throw new FilesApiError('Files request failed (500)', 500) },
    });

    expect((await sharing.capabilities()).onlineOnlyReason).toBe('Files request failed (500)');
  });

  // risk: an unshared file must show an empty share list, not an error that blocks the share dialog
  it('returns an empty share list when file-shares answers 404', async() => {
    const { handlers } = harness({
      '/v1/files/file-1/shares': async() => { throw new FilesApiError('Files request failed (404)', 404) },
    });

    await expect(handlers.get('sulla-files:file-shares')!({}, { fileId: 'file-1' })).resolves.toEqual([]);
  });

  it('still rejects file-shares failures that are not 404', async() => {
    const { handlers } = harness({
      '/v1/files/file-1/shares': async() => { throw new FilesApiError('Files request failed (500)', 500) },
    });

    await expect(handlers.get('sulla-files:file-shares')!({}, { fileId: 'file-1' })).rejects.toThrow('Files request failed (500)');
  });
});
