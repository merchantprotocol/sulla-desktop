// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { FilesApiError } from './sullaFilesClient';

import type { SullaFilesIpcOpenedCopyService, SullaFilesReferenceInput } from './SullaFilesIpcOpenedCopyService';
import type { SullaFilesIpcDesktop, SullaFilesIpcServices } from './SullaFilesIpcSupport';
import type { FilesRevealResult } from '@pkg/pages/files/types';

interface OriginalRevealTarget {
  rootId:string;
  collectionId:string;
  relativePath:string;
  fileId:string;
  versionId:string;
  revision:string;
  hash:string;
  size:number;
  mtimeMs:number;
}

type OriginalRevealAttestation =
  | { status:'attested'; token:string; expiresAt:number; target:OriginalRevealTarget }
  | { status:'unavailable'; code:'no-current-original' };

interface VerifiedOriginalTarget {
  candidate:string;
  rootDev:bigint;
  rootIno:bigint;
  fileDev:bigint;
  fileIno:bigint;
}

/**
 * Reveals a tracked host original only after the Files service attests it and
 * main re-verifies its root, path, identity and content hash. Falls back to the
 * verified downloaded copy when no current original exists.
 */
export class SullaFilesIpcOriginalRevealService {
  constructor(
    private readonly services:Pick<SullaFilesIpcServices, 'watcher' | 'rootRegistry' | 'isProtectedTrackedPath'>,
    private readonly copies:Pick<SullaFilesIpcOpenedCopyService, 'revealMaterializedCopy'>,
    private readonly desktop:Pick<SullaFilesIpcDesktop, 'showItemInFolder'>,
    private readonly now:() => number = Date.now,
  ) {}

  async reveal(input:SullaFilesReferenceInput):Promise<FilesRevealResult> {
    // The service authorizes the visible version and vouches for a current
    // watched original before main ever resolves a host path.
    const attestation = await this.nativeJson<OriginalRevealAttestation>('/v1/original-reveal/attest', input);
    if (!attestation || typeof attestation !== 'object') throw new Error('Files returned an invalid original reveal attestation.');
    if (attestation.status === 'unavailable') {
      if (attestation.code !== 'no-current-original') throw new Error('Files returned an invalid original reveal result.');
      return this.copies.revealMaterializedCopy(input);
    }
    if (attestation.status !== 'attested' || typeof attestation.token !== 'string' || !attestation.token || attestation.token.length > 200 ||
        !Number.isSafeInteger(attestation.expiresAt) || attestation.expiresAt <= this.now()) throw new Error('Files returned an invalid original reveal attestation.');
    const attested = this.originalTarget(attestation.target, input);
    const verified = await this.verifyOriginalTarget(attested).catch(() => {
      // Native filesystem errors contain absolute paths; keep those in main.
      throw new Error('The tracked original is unavailable, unsafe, or changed. Refresh Files and try again.');
    });
    if (attestation.expiresAt <= this.now()) throw new Error('Original reveal authorization expired while verifying the file. Try again.');
    const redeemed = await this.nativeJson<{ status:'redeemed'; target:unknown }>('/v1/original-reveal/redeem', { token: attestation.token });
    if (redeemed.status !== 'redeemed') throw new Error('Files returned an invalid original reveal redemption.');
    const current = this.originalTarget(redeemed.target, input);
    if (!this.sameOriginalTarget(attested, current)) throw new Error('The tracked original changed before it could be revealed.');
    const finalCandidate = await this.recheckOriginalTarget(current, verified).catch(() => {
      throw new Error('The tracked original changed or became unavailable before it could be revealed.');
    });
    // Electron accepts only a string path, not our verified descriptor. A
    // same-user filesystem writer can still race the close and native shell call.
    this.desktop.showItemInFolder(finalCandidate);

    return { status: 'revealed', target: 'tracked-original', fileId: input.fileId, versionId: current.versionId };
  }

  private async nativeJson<T>(endpoint:string, body:unknown):Promise<T> {
    const response = await this.services.watcher().requestNativeFiles(endpoint, { method: 'POST', body: JSON.stringify(body) });
    if (!response.ok) {
      const result = await response.clone().json().catch(() => ({})) as { error?:unknown; code?:unknown };
      const error = new FilesApiError(typeof result.error === 'string' && result.error ? result.error : `Files request failed (${ response.status })`, response.status);

      if (typeof result.code === 'string') Object.assign(error, { code: result.code });
      throw error;
    }

    return response.json() as Promise<T>;
  }

  private originalTarget(value:unknown, input:SullaFilesReferenceInput):OriginalRevealTarget {
    if (!value || typeof value !== 'object') throw new Error('Files returned an invalid original reveal target.');
    const target = value as Record<string, unknown>;
    const strings = ['rootId', 'collectionId', 'relativePath', 'fileId', 'versionId', 'revision', 'hash'] as const;
    if (strings.some(key => typeof target[key] !== 'string' || !target[key] || (target[key] as string).length > 4096) ||
        target.fileId !== input.fileId || (input.versionId !== undefined && target.versionId !== input.versionId) ||
        !Number.isSafeInteger(target.size) || Number(target.size) < 0 || !Number.isSafeInteger(target.mtimeMs) ||
        !/^[0-9]+$/.test(String(target.revision)) || !/^[0-9a-f]{64}$/.test(String(target.hash))) throw new Error('Files returned an invalid original reveal target.');
    const relativePath = String(target.relativePath);
    if (path.posix.isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.includes('\0') ||
        relativePath.split('/').some(part => !part || part === '.' || part === '..' || part === '.sulla-trash' || part === '.sulla-operation-recovery')) {
      throw new Error('Files returned an unsafe original path.');
    }

    return target as unknown as OriginalRevealTarget;
  }

  private sameOriginalTarget(left:OriginalRevealTarget, right:OriginalRevealTarget):boolean {
    return left.rootId === right.rootId && left.collectionId === right.collectionId && left.relativePath === right.relativePath &&
      left.fileId === right.fileId && left.versionId === right.versionId && left.revision === right.revision &&
      left.hash === right.hash && left.size === right.size && left.mtimeMs === right.mtimeMs;
  }

  private pathWithin(root:string, candidate:string):boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));

    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${ path.sep }`));
  }

  private async resolveOriginalPath(target:OriginalRevealTarget):Promise<{ candidate:string; rootDev:bigint; rootIno:bigint }> {
    const root = await this.services.rootRegistry().rootForCollection(target.collectionId);
    if (!root || root.id !== target.rootId) throw new Error('The tracked original is no longer attached to this Files collection.');
    if (this.services.isProtectedTrackedPath(root.path)) throw new Error('Files cannot reveal originals from a protected local folder.');
    const rootInfo = await fs.promises.lstat(root.path, { bigint: true });
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('The tracked original root is not a safe local folder.');
    const canonicalRoot = await fs.promises.realpath(root.path);
    if (this.services.isProtectedTrackedPath(canonicalRoot)) throw new Error('Files cannot reveal originals from a protected local folder.');
    const canonicalRootInfo = await fs.promises.lstat(canonicalRoot, { bigint: true });
    if (!canonicalRootInfo.isDirectory() || canonicalRootInfo.isSymbolicLink() ||
        canonicalRootInfo.dev !== rootInfo.dev || canonicalRootInfo.ino !== rootInfo.ino) throw new Error('The tracked original root changed while it was being verified.');
    const parent = path.join(canonicalRoot, ...target.relativePath.split('/').slice(0, -1));
    const candidate = path.join(canonicalRoot, ...target.relativePath.split('/'));
    if (!this.pathWithin(canonicalRoot, candidate) || candidate === canonicalRoot ||
        await fs.promises.realpath(parent) !== parent || await fs.promises.realpath(candidate) !== candidate) {
      throw new Error('The tracked original path is no longer safe.');
    }

    return { candidate, rootDev: rootInfo.dev, rootIno: rootInfo.ino };
  }

  private async verifyOriginalTarget(target:OriginalRevealTarget):Promise<VerifiedOriginalTarget> {
    const resolved = await this.resolveOriginalPath(target);
    const { candidate } = resolved;
    const linkInfo = await fs.promises.lstat(candidate, { bigint: true });
    if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) throw new Error('The tracked original is no longer a regular file.');
    const handle = await fs.promises.open(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.dev !== linkInfo.dev || before.ino !== linkInfo.ino ||
          Number(before.size) !== target.size || Number(before.mtimeMs) !== target.mtimeMs) throw new Error('The tracked original changed before it could be revealed.');
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
      const after = await handle.stat({ bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
          hash.digest('hex') !== target.hash) throw new Error('The tracked original changed before it could be revealed.');
    } finally { await handle.close() }

    return { ...resolved, fileDev: linkInfo.dev, fileIno: linkInfo.ino };
  }

  private async recheckOriginalTarget(target:OriginalRevealTarget, verified:VerifiedOriginalTarget):Promise<string> {
    const resolved = await this.resolveOriginalPath(target);
    if (resolved.candidate !== verified.candidate || resolved.rootDev !== verified.rootDev || resolved.rootIno !== verified.rootIno) {
      throw new Error('The tracked original root changed before it could be revealed.');
    }
    const handle = await fs.promises.open(resolved.candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const current = await handle.stat({ bigint: true });
      if (!current.isFile() || current.dev !== verified.fileDev || current.ino !== verified.fileIno ||
          Number(current.size) !== target.size || Number(current.mtimeMs) !== target.mtimeMs) {
        throw new Error('The tracked original changed before it could be revealed.');
      }
    } finally { await handle.close() }

    return resolved.candidate;
  }
}
