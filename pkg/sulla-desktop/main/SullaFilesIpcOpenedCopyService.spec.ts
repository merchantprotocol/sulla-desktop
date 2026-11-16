// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./sullaFilesWatcher', () => ({ getSullaFilesWatcher: vi.fn() }));

import { SullaFilesIpcOpenedCopyService } from './SullaFilesIpcOpenedCopyService';
import { SullaFilesIpcApi } from './SullaFilesIpcSupport';

describe('SullaFilesIpcOpenedCopyService', () => {
  let cache:string;

  beforeEach(async() => { cache = await fs.mkdtemp(path.join(os.tmpdir(), 'sulla-files-open-')) });
  afterEach(async() => { await fs.rm(cache, { recursive: true, force: true }) });

  function harness(options:{ history?:any[]; streamStatus?:number; openError?:string; file?:any } = {}) {
    const client = {
      json: vi.fn(async(endpoint:string) => endpoint.endsWith('/history')
        ? options.history ?? [{ id: 'v1', deleted: false }]
        : options.file ?? { id: 'f1', path: 'Docs/re?port.txt', current_version_id: 'v1' }),
      stream: vi.fn(async(_endpoint:string, init:RequestInit = {}) => {
        const status = options.streamStatus ?? 200;
        return new Response(init.method === 'HEAD' || status !== 200 ? null : 'file body', { status });
      }),
    };
    const desktop = { openPath: vi.fn(async() => options.openError ?? ''), showItemInFolder: vi.fn() };
    const service = new SullaFilesIpcOpenedCopyService(new SullaFilesIpcApi(client as any), desktop, () => cache);

    return { service, client, desktop };
  }

  it('rejects malformed references before contacting Files', async() => {
    // risk: input validation — oversized or empty ids must never reach the service.
    const { service, client } = harness();
    await expect(service.authorize({ fileId: '' })).rejects.toThrow('Choose a valid Files reference.');
    await expect(service.authorize({ fileId: 'x'.repeat(257) })).rejects.toThrow('Choose a valid Files reference.');
    await expect(service.authorize({ fileId: 'f1', versionId: '' })).rejects.toThrow('Choose a valid Files reference.');
    expect(client.json).not.toHaveBeenCalled();
  });

  it('refuses a version that was deleted', async() => {
    // risk: data access — deleted versions must not be opened or revealed.
    const { service } = harness({ history: [{ id: 'v1', deleted: true }] });
    await expect(service.authorize({ fileId: 'f1' })).rejects.toThrow('That file version is no longer available.');
  });

  it('downloads the version into the private open cache with a sanitized name', async() => {
    // risk: data integrity + path safety — content lands in files-open under a safe name, nothing else is left behind.
    const { service } = harness();
    const target = await service.materialize({ fileId: 'f1' });
    const cacheRoot = path.join(await fs.realpath(cache), 'files-open');
    expect(path.dirname(target)).toBe(cacheRoot);
    expect(path.basename(target)).toMatch(/^[0-9a-f]{64}-re_port\.txt$/);
    expect(await fs.readFile(target, 'utf8')).toBe('file body');
    expect(await fs.readdir(cacheRoot)).toEqual([path.basename(target)]);
  });

  it('fails without leaving a partial file when Files refuses the content', async() => {
    // risk: error path — a failed download must not leave stale content that a later reveal could expose.
    const { service } = harness({ streamStatus: 404 });
    await expect(service.materialize({ fileId: 'f1' })).rejects.toThrow('Files content failed (404)');
    expect(await fs.readdir(path.join(cache, 'files-open'))).toEqual([]);
  });

  it('surfaces the OS error when the copy cannot be opened', async() => {
    // risk: error mapping — a shell.openPath failure string must reach the renderer as an error.
    const { service } = harness({ openError: 'No application' });
    await expect(service.open({ fileId: 'f1' })).rejects.toThrow('No application');
  });

  it('reveals only a copy this session opened, and refuses it once it changes', async() => {
    // risk: security — reveal must only point at the verified copy, never a moved or modified file.
    const { service, desktop } = harness();
    await expect(service.revealMaterializedCopy({ fileId: 'f1' })).resolves.toMatchObject({ status: 'unavailable', code: 'no-local-copy' });
    const target = await service.materialize({ fileId: 'f1' });
    await expect(service.revealMaterializedCopy({ fileId: 'f1' })).resolves.toEqual({ status: 'revealed', target: 'materialized-copy', fileId: 'f1', versionId: 'v1' });
    expect(desktop.showItemInFolder).toHaveBeenCalledWith(target);
    await fs.appendFile(target, ' tampered');
    await expect(service.revealMaterializedCopy({ fileId: 'f1' })).resolves.toMatchObject({ status: 'unavailable', code: 'local-copy-changed' });
    expect(desktop.showItemInFolder).toHaveBeenCalledTimes(1);
  });
});
