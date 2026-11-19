// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false }, ipcMain: { handle: vi.fn() }, shell: {}, systemPreferences: { getMediaAccessStatus: () => 'granted' } }));

import { FilesApiError } from './sullaFilesClient';
import { SullaFilesIpcSharingHandlers } from './SullaFilesIpcSharingHandlers';
import type { SullaFilesIpcRegistrar } from './SullaFilesIpcSupport';

const FILE = '22222222-2222-4222-8222-222222222222';

class FakeRegistrar implements SullaFilesIpcRegistrar {
  readonly handlers = new Map<string, (...args:any[]) => any>();
  handle(channel:string, listener:(...args:any[]) => unknown) { this.handlers.set(channel, listener as any) }
  call(channel:string, ...args:unknown[]) { return this.handlers.get(channel)!({ sender: { id: 1 } }, ...args) }
}

function build(json:ReturnType<typeof vi.fn>) {
  const api = { json } as any;
  const services = {
    watcher: () => ({ status: async() => ({ serverConfigured: true, state: 'ready' }) }),
    linkService: vi.fn(),
  } as any;
  const upload = { cloudFilesAvailable: async() => true } as any;

  return new SullaFilesIpcSharingHandlers(api, services, upload);
}

describe('Files sharing handlers: 404 mapping', () => {
  // risk: an unconfigured install must read as "not configured", not as an opaque failure that breaks files/link
  it('maps a 404 from residency-capabilities to "Not configured on this install"', async() => {
    const json = vi.fn(async(endpoint:string) => {
      if (endpoint === '/v1/residency-capabilities') throw new FilesApiError('Not Found', 404);
      return {};
    });
    const capabilities = await build(json).capabilities();

    expect(capabilities.onlineOnly).toBe(false);
    expect(capabilities.onlineOnlyReason).toBe('Not configured on this install');
    expect(capabilities.publicLinks).toBe(true);
  });

  // risk: a server error other than 404 must still surface so real outages are not hidden
  it('keeps other residency failures as their real message', async() => {
    const json = vi.fn(async() => { throw new FilesApiError('boom', 500) });
    const capabilities = await build(json).capabilities();

    expect(capabilities.onlineOnlyReason).toBe('boom');
  });

  // risk: file links must not fail when a file has no shares route on this server
  it('treats a 404 from file-shares as an empty list', async() => {
    const json = vi.fn(async() => { throw new FilesApiError('Not Found', 404) });
    const ipc = new FakeRegistrar();

    build(json).register(ipc);

    expect(await ipc.call('sulla-files:file-shares', { fileId: FILE })).toEqual([]);
  });

  // risk: a 403 on shares must stay a visible error, not be turned into "no shares"
  it('rethrows non-404 errors from file-shares', async() => {
    const json = vi.fn(async() => { throw new FilesApiError('forbidden', 403) });
    const ipc = new FakeRegistrar();

    build(json).register(ipc);

    await expect(ipc.call('sulla-files:file-shares', { fileId: FILE })).rejects.toThrow('forbidden');
  });
});
