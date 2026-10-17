import { assertUnprotectedFile } from './protectedFiles.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { decryptChunk } from './crypto.js';
import { Store } from './store.js';

import type { Config } from './config.js';
import type pg from 'pg';

const run = promisify(execFile);

export interface FileContent {
  buffer:    Buffer;
  mime:      string;
  fileId:    string;
  versionId: string;
  path:      string;
}

export async function loadFileContent(db:pg.Pool, config:Config, store:Store, fileId:string, versionId?:string):Promise<FileContent | undefined> {
  const result = await db.query(
    `SELECT f.id,f.path,f.mime,COALESCE($2::uuid,f.current_version_id) AS version_id,
            v.chunk_collection_id,m.chunk_ids
       FROM files f
       JOIN file_versions v ON v.id=COALESCE($2::uuid,f.current_version_id) AND v.file_id=f.id
       LEFT JOIN manifests m ON m.hash=v.manifest_hash
      WHERE f.id=$1 AND NOT v.deleted`,
    [fileId, versionId ?? null],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  await assertUnprotectedFile(db, row);
  const key = (await config.keyring!.keys(row.chunk_collection_id)).data;
  const parts:Buffer[] = [];
  for (const id of row.chunk_ids ?? []) parts.push(await decryptChunk(await store.get(row.chunk_collection_id, id), key, id));
  return { buffer: Buffer.concat(parts), mime: row.mime, fileId: row.id, versionId: row.version_id, path: row.path };
}

export async function thumbnail(db:pg.Pool, config:Config, store:Store, fileId:string, versionId?:string):Promise<FileContent | undefined> {
  const content = await loadFileContent(db, config, store, fileId, versionId);
  if (!content) return undefined;
  const cached = await db.query('SELECT relative_path,mime FROM generated_previews WHERE version_id=$1 AND kind=$2', [content.versionId, 'thumbnail']);
  if (cached.rows[0]) {
    try { return { ...content, buffer: await readFile(join(config.dataRoot, cached.rows[0].relative_path)), mime: cached.rows[0].mime } } catch { /* regenerate */ }
  }
  const previewDir = join(config.dataRoot, 'previews');
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
    const finalPath = join(config.dataRoot, relativePath);
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    await rename(output, finalPath);
    await db.query(`INSERT INTO generated_previews(version_id,kind,mime,relative_path) VALUES($1,'thumbnail','image/jpeg',$2)
      ON CONFLICT(version_id,kind) DO UPDATE SET relative_path=EXCLUDED.relative_path,created_at=NOW()`, [content.versionId, relativePath]);
    return { ...content, buffer: await readFile(finalPath), mime: 'image/jpeg' };
  } finally {
    const { unlink } = await import('node:fs/promises');
    await Promise.allSettled([unlink(source), unlink(output)]);
  }
}
