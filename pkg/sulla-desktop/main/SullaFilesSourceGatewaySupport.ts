// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';
import fs, { constants } from 'node:fs';

export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_CONCURRENT_REQUESTS = 4;
export const MAX_TOTAL_INFLIGHT_BYTES = MAX_CONCURRENT_REQUESTS * MAX_SOURCE_BYTES;
export const MAX_CAPABILITY_TTL_MS = 5 * 60_000;
export const BIND_HOST = '127.0.0.1';

export interface RegisteredSource {
  path:       string;
  parentPath: string;
  file:       fs.promises.FileHandle;
  dev:        bigint;
  ino:        bigint;
  epoch:      number;
  release?:   () => void;
}

export type SourcePermission = 'read' | 'write';

export interface SourceCapability {
  handle:      string;
  serviceId:   string;
  permissions: ReadonlySet<SourcePermission>;
  expiresAt:   number;
  epoch:       number;
}

export class SourceGatewayError extends Error {
  constructor(readonly status:number, readonly code:string, message:string, readonly conflictHandle?:string) {
    super(message);
  }
}

export class SullaFilesSourceGatewayFileStore {
  async syncParent(parentPath:string):Promise<void> {
    const parent = await fs.promises.open(parentPath, constants.O_RDONLY);
    try { await parent.sync() } finally { await parent.close() }
  }

  async openPinned(sourcePath:string):Promise<{ file:fs.promises.FileHandle; info:fs.BigIntStats }> {
    const file = await fs.promises.open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const [pathInfo, descriptorInfo] = await Promise.all([
        fs.promises.lstat(sourcePath, { bigint: true }),
        file.stat({ bigint: true }),
      ]);
      if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.dev !== descriptorInfo.dev || pathInfo.ino !== descriptorInfo.ino) {
        throw new SourceGatewayError(409, 'source_identity_changed', 'Source pathname changed while its identity was being pinned');
      }
      return { file, info: descriptorInfo };
    } catch (error) {
      await file.close().catch(() => undefined);
      throw error;
    }
  }
}

export class SullaFilesSourceGatewayRequestBudget {
  private activeRequests = 0;
  private reservedBytes = 0;
  private readonly drainWaiters = new Set<() => void>();

  reserve():boolean {
    if (this.activeRequests >= MAX_CONCURRENT_REQUESTS || this.reservedBytes + MAX_SOURCE_BYTES > MAX_TOTAL_INFLIGHT_BYTES) return false;
    this.activeRequests++;
    this.reservedBytes += MAX_SOURCE_BYTES;
    return true;
  }

  release():void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.reservedBytes = Math.max(0, this.reservedBytes - MAX_SOURCE_BYTES);
    if (!this.activeRequests) {
      for (const resolve of this.drainWaiters) resolve();
      this.drainWaiters.clear();
    }
  }

  async waitForIdle():Promise<void> {
    if (this.activeRequests) await new Promise<void>(resolve => this.drainWaiters.add(resolve));
  }

  async withCapacity<T>(operation:() => Promise<T>):Promise<T> {
    if (!this.reserve()) throw new SourceGatewayError(503, 'gateway_busy', 'Native Files source gateway request limits are reached');
    try { return await operation() } finally { this.release() }
  }
}

export class SullaFilesSourceGatewayFingerprint {
  safeEqual(left:string, right:string):boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  fingerprint(info:fs.BigIntStats, contentHash:string):string {
    return crypto.createHash('sha256').update([info.dev, info.ino, info.size, info.mtimeNs, contentHash].join(':')).digest('hex');
  }
}
