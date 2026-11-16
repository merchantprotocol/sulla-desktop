// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { basename, posix } from 'node:path';

import { decryptChunk } from '../crypto.js';
import { parseByteRange, streamFileContent } from '../fileStream.js';
import { assertUnprotectedFile, isProtectedPath } from '../protectedFiles.js';

import type { Config } from '../config.js';
import type { ShareLinkRepository, ShareQueryable } from '../Repositories/ShareLinkRepository.js';
import type { Store } from '../store.js';
import type pg from 'pg';
import { LikePattern } from '../LikePattern.js';

export interface ShareStreamContent {
  body:          AsyncIterable<Buffer>;
  mime:          string;
  name:          string;
  status:        200 | 206;
  contentLength: number;
  contentRange?: string;
}

export interface ShareContent { bytes:Buffer; mime:string; name:string }

/** Resolves a public share to the bytes it exposes: a folder's JSON listing or one file's content. */
export class ShareContentReader {
  constructor(
    private readonly db:pg.Pool,
    private readonly config:Config,
    private readonly store:Store,
    private readonly links:ShareLinkRepository,
  ) {}

  async stream(id:string, requestedPath:string, rangeHeader:string | undefined, signal:AbortSignal):Promise<ShareStreamContent> {
    const share = await this.links.findActive(id);
    if (!share) throw Object.assign(new Error('share not found or inactive'), { status: 404 });
    if (share.target_type === 'folder' && !requestedPath) {
      const listing = await this.read(id, requestedPath, false, this.db);
      const range = parseByteRange(rangeHeader, listing.bytes.length);
      const bytes = range ? listing.bytes.subarray(range.start, range.end + 1) : listing.bytes;
      async function * body() { signal.throwIfAborted(); if (bytes.length) yield bytes }
      return { body: body(), mime: listing.mime, name: listing.name, status: range ? 206 : 200, contentLength: bytes.length,
        contentRange: range ? `bytes ${ range.start }-${ range.end }/${ listing.bytes.length }` : undefined };
    }
    let file;
    if (share.target_type === 'file') file = await this.links.findLiveFile(this.db, share.file_id);
    else {
      const relative = posix.normalize(requestedPath.replace(/^\/+/, ''));
      if (!relative || relative === '..' || relative.startsWith('../')) throw Object.assign(new Error('invalid shared path'), { status: 400 });
      file = await this.links.findLiveFileAt(this.db, share.collection_id, `${ share.folder_path }/${ relative }`);
    }
    if (!file) throw Object.assign(new Error('shared file not found'), { status: 404 });
    if (!file.current_version_id) throw Object.assign(new Error('shared file has no version'), { status: 404 });
    await assertUnprotectedFile(this.db, file);
    const stream = await streamFileContent(this.db, this.config, this.store, file.id, file.current_version_id, rangeHeader, signal);
    if (!stream) throw Object.assign(new Error('shared file has no readable version'), { status: 404 });
    return { body: stream.body, mime: stream.mime, name: basename(stream.path), status: stream.range ? 206 : 200,
      contentLength: stream.contentLength, contentRange: stream.range ? `bytes ${ stream.range.start }-${ stream.range.end }/${ stream.size }` : undefined };
  }

  async read(id:string, requestedPath:string, allowPendingPublication:boolean, queryable:ShareQueryable):Promise<ShareContent> {
    const share = await this.links.findReadable(queryable, id, allowPendingPublication);
    if (!share) throw Object.assign(new Error('share not found or inactive'), { status: 404 });
    if (share.target_type === 'folder' && !requestedPath) {
      const prefix = `${ share.folder_path }/`;
      const files = (await this.links.folderFiles(queryable, share.collection_id, LikePattern.prefix(prefix)))
        .filter(row => !isProtectedPath(row.path)).map(row => ({ ...row, path: row.path.slice(prefix.length) }));
      return { bytes: Buffer.from(JSON.stringify({ name: share.display_name, files })), mime: 'application/json', name: `${ share.display_name }.json` };
    }
    let file;
    if (share.target_type === 'file') file = await this.links.findLiveFile(queryable, share.file_id);
    else {
      const relative = posix.normalize(requestedPath.replace(/^\/+/, ''));
      if (!relative || relative === '..' || relative.startsWith('../')) throw Object.assign(new Error('invalid shared path'), { status: 400 });
      const full = `${ share.folder_path }/${ relative }`;
      file = await this.links.findLiveFileAt(queryable, share.collection_id, full);
    }
    if (!file) throw Object.assign(new Error('shared file not found'), { status: 404 });
    if (!file.current_version_id) throw Object.assign(new Error('shared file has no version'), { status: 404 });
    await assertUnprotectedFile(queryable, file);
    const version = await this.links.readableVersion(queryable, file.current_version_id);
    if (!version) throw Object.assign(new Error('shared file has no readable version'), { status: 404 });
    const key = (await this.config.keyring!.keys(version.chunk_collection_id, queryable)).data;
    const chunks: Buffer[] = []; for (const chunkId of version.chunk_ids) chunks.push(await decryptChunk(await this.store.get(version.chunk_collection_id, chunkId), key, chunkId));
    return { bytes: Buffer.concat(chunks), mime: file.mime, name: basename(file.path) };
  }
}
