// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./sullaFilesWatcher', () => ({ getSullaFilesWatcher: vi.fn() }));

import { FilesApiError } from './sullaFilesClient';
import { SullaFilesIpcOriginalRevealService } from './SullaFilesIpcOriginalRevealService';

const FILE_ID = 'file-1';
const VERSION_ID = 'version-1';
const MTIME_SECONDS = 1_700_000_000;

describe('SullaFilesIpcOriginalRevealService', () => {
  let temporary:string;
  let root:string;
  let target:Record<string, unknown>;

  beforeEach(async() => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sulla-files-reveal-'));
    root = path.join(temporary, 'root');
    await fs.mkdir(path.join(root, 'notes'), { recursive: true });
    const file = path.join(root, 'notes', 'a.txt');
    await fs.writeFile(file, 'hello original');
    await fs.utimes(file, MTIME_SECONDS, MTIME_SECONDS);
    target = {
      rootId: 'root-1', collectionId: 'collection-1', relativePath: 'notes/a.txt', fileId: FILE_ID, versionId: VERSION_ID,
      revision: '7', hash: createHash('sha256').update('hello original').digest('hex'), size: 'hello original'.length, mtimeMs: MTIME_SECONDS * 1000,
    };
  });

  afterEach(async() => { await fs.rm(temporary, { recursive: true, force: true }) });

  function harness(options:{ attest?:unknown; redeem?:unknown; protectedPath?:boolean; status?:number; errorBody?:unknown } = {}) {
    const calls:string[] = [];
    const requestNativeFiles = vi.fn(async(endpoint:string) => {
      calls.push(endpoint);
      if (options.status) return new Response(JSON.stringify(options.errorBody ?? {}), { status: options.status });
      if (endpoint === '/v1/original-reveal/attest') {
        return Response.json(options.attest ?? { status: 'attested', token: 'token-1', expiresAt: Date.now() + 60_000, target });
      }
      return Response.json(options.redeem ?? { status: 'redeemed', target });
    });
    const services = {
      watcher:                () => ({ requestNativeFiles }) as any,
      rootRegistry:           () => ({ rootForCollection: vi.fn(async() => ({ id: 'root-1', path: root })) }) as any,
      isProtectedTrackedPath: vi.fn(() => options.protectedPath === true),
    };
    const copies = { revealMaterializedCopy: vi.fn(async() => ({ status: 'unavailable', code: 'no-local-copy', reason: 'copy' }) as any) };
    const desktop = { showItemInFolder: vi.fn() };

    return { service: new SullaFilesIpcOriginalRevealService(services, copies, desktop), calls, copies, desktop };
  }

  it('reveals the attested, verified original at its canonical host path', async() => {
    // risk: data integrity — the reveal must land on the exact attested file under the tracked root.
    const { service, desktop, calls } = harness();
    await expect(service.reveal({ fileId: FILE_ID, versionId: VERSION_ID })).resolves.toEqual({ status: 'revealed', target: 'tracked-original', fileId: FILE_ID, versionId: VERSION_ID });
    expect(calls).toEqual(['/v1/original-reveal/attest', '/v1/original-reveal/redeem']);
    expect(desktop.showItemInFolder).toHaveBeenCalledWith(path.join(await fs.realpath(root), 'notes', 'a.txt'));
  });

  it('refuses a changed original without redeeming or revealing, and hides host paths in the error', async() => {
    // risk: security — a file whose content no longer matches the attested hash must never be revealed.
    target.hash = 'f'.repeat(64);
    const { service, desktop, calls } = harness();
    await expect(service.reveal({ fileId: FILE_ID })).rejects.toThrow('The tracked original is unavailable, unsafe, or changed. Refresh Files and try again.');
    expect(calls).toEqual(['/v1/original-reveal/attest']);
    expect(desktop.showItemInFolder).not.toHaveBeenCalled();
  });

  it('rejects an attested path that escapes the tracked root', async() => {
    // risk: path traversal — the service must not be able to point main at a file outside the root.
    target.relativePath = '../outside.txt';
    const { service, desktop } = harness();
    await expect(service.reveal({ fileId: FILE_ID })).rejects.toThrow('Files returned an unsafe original path.');
    expect(desktop.showItemInFolder).not.toHaveBeenCalled();
  });

  it('rejects an attestation for a different file than the one requested', async() => {
    // risk: authorization — an attestation for another file must not reveal it.
    target.fileId = 'someone-else';
    const { service } = harness();
    await expect(service.reveal({ fileId: FILE_ID })).rejects.toThrow('Files returned an invalid original reveal target.');
  });

  it('never reveals originals from a protected local folder', async() => {
    // risk: security — protected system folders stay hidden even when attested.
    const { service, desktop } = harness({ protectedPath: true });
    await expect(service.reveal({ fileId: FILE_ID })).rejects.toThrow('The tracked original is unavailable, unsafe, or changed. Refresh Files and try again.');
    expect(desktop.showItemInFolder).not.toHaveBeenCalled();
  });

  it('refuses when the redeemed target differs from the attested one', async() => {
    // risk: TOCTOU — a target that changed between attest and redeem must not be revealed.
    const { service, desktop } = harness({ redeem: { status: 'redeemed', target: { ...target, revision: '8' } } });
    await expect(service.reveal({ fileId: FILE_ID })).rejects.toThrow('The tracked original changed before it could be revealed.');
    expect(desktop.showItemInFolder).not.toHaveBeenCalled();
  });

  it('rejects an already expired attestation', async() => {
    // risk: replay — expired authorization must not be honoured.
    const { service } = harness({ attest: { status: 'attested', token: 'token-1', expiresAt: Date.now() - 1, target } });
    await expect(service.reveal({ fileId: FILE_ID })).rejects.toThrow('Files returned an invalid original reveal attestation.');
  });

  it('falls back to the downloaded copy when there is no current original', async() => {
    // risk: behaviour — files without a tracked original must still reveal their verified local copy.
    const { service, copies, desktop } = harness({ attest: { status: 'unavailable', code: 'no-current-original' } });
    await expect(service.reveal({ fileId: FILE_ID })).resolves.toMatchObject({ code: 'no-local-copy' });
    expect(copies.revealMaterializedCopy).toHaveBeenCalledWith({ fileId: FILE_ID });
    expect(desktop.showItemInFolder).not.toHaveBeenCalled();
  });

  it('surfaces native service errors with status and code', async() => {
    // risk: error mapping — the renderer relies on the service message, status and code.
    const { service } = harness({ status: 403, errorBody: { error: 'Denied', code: 'forbidden' } });
    const error = await service.reveal({ fileId: FILE_ID }).catch(caught => caught);
    expect(error).toBeInstanceOf(FilesApiError);
    expect(error).toMatchObject({ message: 'Denied', status: 403, code: 'forbidden' });
  });
});
