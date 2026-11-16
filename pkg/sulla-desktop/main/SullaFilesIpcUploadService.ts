// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import path from 'node:path';

import { FilesApiError, getSullaFilesClient } from './sullaFilesClient';
import { getIntegrationService } from '@pkg/agent/services/IntegrationService';

const MAX_DIRECT_UPLOAD_BYTES = 64 * 1024 * 1024;
const FILES_RETRY_DELAY_MS = 1_500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class SullaFilesIpcUploadService {
  private filesReadyRetry?:ReturnType<typeof setTimeout>;

  constructor(private readonly filesClient = getSullaFilesClient()) {}

  private filesTemporarilyUnavailable(error:unknown):boolean {
    return error instanceof FilesApiError ? error.status >= 500
      : error instanceof TypeError || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) ||
        (error instanceof Error && (error.message === 'Files service is unavailable' ||
          /net::ERR_(CONNECTION_(REFUSED|RESET|CLOSED|ABORTED)|EMPTY_RESPONSE|TIMED_OUT|NETWORK_CHANGED)\b/.test(error.message)));
  }

  private queueFilesReadyRetry():void {
    if (this.filesReadyRetry) return;
    this.filesReadyRetry = setTimeout(() => {
      this.filesReadyRetry = undefined;
      void this.filesClient.request('/healthz', { signal: AbortSignal.timeout(3_000) })
        .then(response => response.body?.cancel()).catch(() => undefined);
    }, FILES_RETRY_DELAY_MS);
    this.filesReadyRetry.unref();
  }

  async readyFilesJson<T>(endpoint:string, init:RequestInit):Promise<T> {
    try { return await this.filesClient.json<T>(endpoint, init) }
    catch (error) {
      if (!this.filesTemporarilyUnavailable(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, FILES_RETRY_DELAY_MS));
      try { return await this.filesClient.json<T>(endpoint, init) }
      catch (retryError) {
        if (this.filesTemporarilyUnavailable(retryError)) this.queueFilesReadyRetry();
        throw retryError;
      }
    }
  }

  async cloudFilesAvailable():Promise<boolean> {
    try {
      const account = await getIntegrationService().getConnectionStatus('sulla-cloud');
      if (!account.connected) return false;
      const { getCloudConnectionStatus } = await import('@pkg/main/cloud/cloudLifecycle');
      const cloud = await getCloudConnectionStatus();
      return cloud.signedIn && cloud.device.registered && !cloud.device.revoked && cloud.channel?.state === 'connected';
    } catch { return false }
  }

  async json(endpoint:string, init:RequestInit = {}, server = false):Promise<unknown> {
    return this.filesClient.json(endpoint, init, { server });
  }

  private stableUploadIdentity(left:fs.BigIntStats, right:fs.BigIntStats):boolean {
    return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
  }

  private storedPath(destination:string, name:string):string {
    const normalized = destination.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
    if (normalized.split('/').some(part => part === '.' || part === '..')) throw new Error('Upload destination is not a valid Files folder');
    return [normalized, path.basename(name)].filter(Boolean).join('/');
  }

  private async readStableUpload(source:string):Promise<Buffer> {
    const selected = await fs.promises.lstat(source, { bigint: true });
    if (!selected.isFile() || selected.isSymbolicLink()) throw new Error('Only regular files can be uploaded');
    if (selected.size > BigInt(MAX_DIRECT_UPLOAD_BYTES)) throw new Error('Files selected in Desktop must be 64 MiB or smaller');
    const file = await fs.promises.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const before = await file.stat({ bigint: true });
      if (!this.stableUploadIdentity(selected, before)) throw new Error('Selected file changed before it could be read');
      const chunks:Buffer[] = [];
      let total = 0;
      while (total <= MAX_DIRECT_UPLOAD_BYTES) {
        const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, MAX_DIRECT_UPLOAD_BYTES - total + 1));
        const { bytesRead } = await file.read(chunk, 0, chunk.byteLength, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > MAX_DIRECT_UPLOAD_BYTES) throw new Error('Files selected in Desktop must be 64 MiB or smaller');
        chunks.push(chunk.subarray(0, bytesRead));
      }
      const bytes = Buffer.concat(chunks, total);
      const [after, pathname] = await Promise.all([file.stat({ bigint: true }), fs.promises.lstat(source, { bigint: true })]);
      if (!this.stableUploadIdentity(before, after) || !this.stableUploadIdentity(after, pathname) || bytes.byteLength !== Number(after.size)) {
        throw new Error('Selected file changed while it was being read. Nothing was uploaded.');
      }
      return bytes;
    } finally { await file.close() }
  }

  async importPaths(paths:string[], destination = '', progress?:(value:{current:number;total:number;name:string;percent:number;done:boolean}) => void, collectionId?:string):Promise<number> {
    if (!collectionId || !UUID.test(collectionId)) throw new Error('Choose a Files collection before uploading');
    if (!Array.isArray(paths) || paths.length > 250) throw new Error('Choose no more than 250 files at once');
    let imported = 0;
    for (const [index, source] of paths.entries()) {
      progress?.({ current:index + 1, total:paths.length, name:path.basename(source), percent:12, done:false });
      const bytes = await this.readStableUpload(source);
      const target = this.storedPath(destination, source);
      const response = await this.filesClient.request(`/v1/files/import?collectionId=${ encodeURIComponent(collectionId) }&path=${ encodeURIComponent(target) }&conflict=keep-both`, {
        method:'PUT', headers:{ 'content-type':'application/octet-stream' }, body:bytes as unknown as BodyInit,
      });
      if (!response.ok) throw new FilesApiError((await response.json().catch(() => ({})) as {error?:string}).error ?? `Files upload failed (${ response.status })`, response.status);
      imported++;
      progress?.({ current:index + 1, total:paths.length, name:path.basename(source), percent:100, done:index + 1 === paths.length });
    }
    return imported;
  }
}
