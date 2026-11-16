// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { decryptChunk } from '../crypto.js';
import { assertUnprotectedFile } from '../protectedFiles.js';
import { PreviewRepository } from '../Repositories/PreviewRepository.js';

import type { Config } from '../config.js';
import type { Store } from '../store.js';
import type pg from 'pg';

const run = promisify(execFile);

export interface FileContent {
  buffer:    Buffer;
  mime:      string;
  fileId:    string;
  versionId: string;
  path:      string;
}

/** Decrypts a file version's content and renders (and caches) its thumbnail. */
export class FilePreviewService {
  constructor(
    private readonly db:Pick<pg.Pool, 'query'>,
    private readonly config:Config,
    private readonly store:Store,
    private readonly previews:PreviewRepository = new PreviewRepository(db),
  ) {}

  async loadFileContent(fileId:string, versionId?:string):Promise<FileContent | undefined> {
    const row = await this.previews.findVersionContent(fileId, versionId);
    if (!row) return undefined;
    await assertUnprotectedFile(this.db, row);
    const key = (await this.config.keyring!.keys(row.chunk_collection_id)).data;
    const parts:Buffer[] = [];
    for (const id of row.chunk_ids ?? []) parts.push(await decryptChunk(await this.store.get(row.chunk_collection_id, id), key, id));
    return { buffer: Buffer.concat(parts), mime: row.mime, fileId: row.id, versionId: row.version_id, path: row.path };
  }

  async thumbnail(fileId:string, versionId?:string):Promise<FileContent | undefined> {
    const content = await this.loadFileContent(fileId, versionId);
    if (!content) return undefined;
    const cached = await this.previews.findPreview(content.versionId, 'thumbnail');
    if (cached) {
      try { return { ...content, buffer: await readFile(join(this.config.dataRoot, cached.relative_path)), mime: cached.mime } } catch { /* regenerate */ }
    }
    const previewDir = join(this.config.dataRoot, 'previews');
    await mkdir(previewDir, { recursive: true, mode: 0o700 });
    const nonce = randomUUID();
    const source = join(previewDir, `${ nonce }.source`);
    const output = join(previewDir, `${ nonce }.jpg`);
    await writeFile(source, content.buffer, { mode: 0o600 });
    try {
      if (content.mime === 'application/pdf') {
        await run('pdftoppm', ['-f', '1', '-singlefile', '-scale-to', '640', '-jpeg', source, output.slice(0, -4)], { timeout: 30_000 });
      } else {
        const filter = content.mime.startsWith('audio/') ? 'showwavespic=s=640x360:colors=#5096b3' : `${ content.mime.startsWith('video/') ? 'thumbnail,' : '' }scale=640:640:force_original_aspect_ratio=decrease`;
        await run('ffmpeg', ['-loglevel', 'error', '-y', '-i', source, '-vf', filter, '-frames:v', '1', output], { timeout: 30_000 });
      }
      const relativePath = `previews/${ content.versionId }.jpg`;
      const finalPath = join(this.config.dataRoot, relativePath);
      await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
      await rename(output, finalPath);
      await this.previews.saveThumbnail(content.versionId, relativePath);
      return { ...content, buffer: await readFile(finalPath), mime: 'image/jpeg' };
    } finally {
      await Promise.allSettled([unlink(source), unlink(output)]);
    }
  }
}
