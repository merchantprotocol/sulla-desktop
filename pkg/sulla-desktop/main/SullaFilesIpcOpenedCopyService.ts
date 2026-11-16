// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { SullaFilesIpcApi, SullaFilesIpcDesktop } from './SullaFilesIpcSupport';
import type { FilesRevealResult } from '@pkg/pages/files/types';

interface OpenedFileCopy {
  root:string;
  target:string;
  rootInfo:fs.Stats;
  info:fs.Stats;
}

export interface SullaFilesReferenceInput { fileId:string; versionId?:string }

/**
 * Authorizes Files references and owns the verified local copies Desktop
 * downloads to open them. Only copies this instance created can be revealed.
 */
export class SullaFilesIpcOpenedCopyService {
  private readonly openedFileCopies = new Map<string, OpenedFileCopy>();

  constructor(
    private readonly api:SullaFilesIpcApi,
    private readonly desktop:Pick<SullaFilesIpcDesktop, 'openPath' | 'showItemInFolder'>,
    private readonly cachePath:() => string,
  ) {}

  private copyKey(fileId:string, versionId:string):string { return JSON.stringify([fileId, versionId]) }

  async authorize(input:SullaFilesReferenceInput):Promise<{ file:any; versionId:string }> {
    if (!input || typeof input.fileId !== 'string' || !input.fileId || input.fileId.length > 256 ||
        (input.versionId !== undefined && (typeof input.versionId !== 'string' || !input.versionId || input.versionId.length > 256))) {
      throw new Error('Choose a valid Files reference.');
    }
    const file = await this.api.json(`/v1/files/${ encodeURIComponent(input.fileId) }`);
    const versionId = input.versionId || file.current_version_id;
    if (typeof versionId !== 'string' || !versionId) throw new Error('This file has no readable version.');
    const versions = await this.api.json(`/v1/files/${ encodeURIComponent(input.fileId) }/history`) as any[];
    if (!versions.some(version => version.id === versionId && !version.deleted)) throw new Error('That file version is no longer available.');

    return { file, versionId };
  }

  async materialize(input:SullaFilesReferenceInput):Promise<string> {
    const { file, versionId } = await this.authorize(input);
    const cacheParent = await fs.promises.realpath(this.cachePath());
    const cacheRoot = path.join(cacheParent, 'files-open');
    await fs.promises.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    const rootInfo = await fs.promises.lstat(cacheRoot);
    if (!rootInfo.isDirectory() || await fs.promises.realpath(cacheRoot) !== cacheRoot) throw new Error('Files open cache is not a safe local folder.');
    const safeName = path.basename(String(file.path || 'file')).replace(/[^a-zA-Z0-9._ -]/g, '_');
    const safeId = createHash('sha256').update(this.copyKey(input.fileId, versionId)).digest('hex');
    const target = path.join(cacheRoot, `${ safeId }-${ safeName }`);
    const temp = `${ target }.partial-${ process.pid }-${ randomUUID() }`;
    let ownsTemp = false;
    const response = await this.api.client.stream(`/v1/files/${ encodeURIComponent(input.fileId) }/preview?versionId=${ encodeURIComponent(versionId) }`);
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Files content failed (${ response.status })`) }
    if (!response.body) throw new Error('Files content response was empty');
    try {
      const handle = await fs.promises.open(temp, 'wx', 0o600); ownsTemp = true;
      await pipeline(Readable.fromWeb(response.body as any), handle.createWriteStream());
      await fs.promises.rename(temp, target);
      ownsTemp = false;
    } catch (error) { await response.body.cancel().catch(() => undefined); if (ownsTemp) await fs.promises.rm(temp, { force: true }); throw error }
    const copy = { root: cacheRoot, target, rootInfo, info: await fs.promises.lstat(target) };
    if (!this.validOpenedCopy(copy)) throw new Error('The local Files copy changed before it could be opened.');
    const key = this.copyKey(input.fileId, versionId);
    this.openedFileCopies.delete(key);
    this.openedFileCopies.set(key, copy);
    if (this.openedFileCopies.size > 256) this.openedFileCopies.delete(this.openedFileCopies.keys().next().value!);
    return target;
  }

  async open(input:SullaFilesReferenceInput):Promise<void> {
    const error = await this.desktop.openPath(await this.materialize(input));
    if (error) throw new Error(error);
  }

  async revealMaterializedCopy(input:SullaFilesReferenceInput):Promise<FilesRevealResult> {
    const { versionId } = await this.authorize(input);
    const key = this.copyKey(input.fileId, versionId);
    const copy = this.openedFileCopies.get(key);
    if (!copy) return { status: 'unavailable', code: 'no-local-copy', reason: 'No verified local copy is available. Open this version first, then reveal its downloaded copy. An original host file is not available through this action.' };
    // Re-authorize content, including collection access and draft visibility, even for cached copies.
    const response = await this.api.client.stream(`/v1/files/${ encodeURIComponent(input.fileId) }/preview?versionId=${ encodeURIComponent(versionId) }`, { method: 'HEAD' });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Files content authorization failed (${ response.status })`);
    // Keep the final filesystem validation and native call in the same turn.
    if (!this.validOpenedCopy(copy)) {
      this.openedFileCopies.delete(key);
      return { status: 'unavailable', code: 'local-copy-changed', reason: 'The local copy was moved, changed, or removed. Open this version again before revealing its downloaded copy.' };
    }
    this.desktop.showItemInFolder(copy.target);

    return { status: 'revealed', target: 'materialized-copy', fileId: input.fileId, versionId };
  }

  private validOpenedCopy(copy:OpenedFileCopy):boolean {
    try {
      const root = fs.lstatSync(copy.root); const info = fs.lstatSync(copy.target);

      return root.isDirectory() && root.dev === copy.rootInfo.dev && root.ino === copy.rootInfo.ino &&
        fs.realpathSync(copy.root) === copy.root && path.dirname(copy.target) === copy.root &&
        info.isFile() && info.nlink === 1 && fs.realpathSync(copy.target) === copy.target &&
        info.dev === copy.info.dev && info.ino === copy.info.ino && info.size === copy.info.size &&
        info.mtimeMs === copy.info.mtimeMs && info.ctimeMs === copy.info.ctimeMs;
    } catch { return false }
  }
}
