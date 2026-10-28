// SPDX-License-Identifier: GPL-2.0-or-later
import { randomUUID } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { decryptChunk } from './crypto.js';
import { assertUnprotectedFile, isProtectedPath, protectedPathError } from './protectedFiles.js';
import { FilesMutationCoordinator } from './safeFilesystem.js';
import { Store } from './store.js';
const MAX_INDEX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
function inside(root, relativePath) {
    const target = resolve(root, relativePath);
    if (target !== root && !target.startsWith(`${root}${sep}`))
        throw new Error('Index source path escapes its Files root');
    return target;
}
export function desktopIndexSource(filesRoot, db) {
    return async (file) => {
        if (isProtectedPath(file.path))
            throw protectedPathError();
        if (db)
            await assertUnprotectedFile(db, file);
        const root = db
            ? (await db.query('SELECT mount_path FROM file_roots WHERE collection_id=$1 AND enabled=TRUE', [file.collection_id])).rows[0]?.mount_path
            : filesRoot;
        if (!root)
            throw new Error('Index source collection has no active Files root');
        const relativePath = file.path;
        inside(resolve(root), relativePath);
        const pinned = await new FilesMutationCoordinator(root).pin(relativePath);
        const tempRoot = join(tmpdir(), 'sulla-files-index');
        const path = join(tempRoot, randomUUID());
        let output;
        try {
            if (pinned.fingerprint.size > MAX_INDEX_SOURCE_BYTES)
                throw new Error('Index source exceeds the 2 GiB local extraction limit');
            await mkdir(tempRoot, { recursive: true, mode: 0o700 });
            output = await open(path, 'wx', 0o600);
            let total = 0;
            for await (const value of pinned.createReadStream()) {
                const bytes = Buffer.from(value);
                total += bytes.byteLength;
                if (total > MAX_INDEX_SOURCE_BYTES)
                    throw new Error('Index source exceeded the 2 GiB local extraction limit while copying');
                let offset = 0;
                while (offset < bytes.byteLength) {
                    const { bytesWritten } = await output.write(bytes, offset, bytes.byteLength - offset);
                    if (!bytesWritten)
                        throw new Error('Index source snapshot made no write progress');
                    offset += bytesWritten;
                }
            }
            await output.sync();
            await output.close();
            output = undefined;
            await pinned.assertUnchanged();
            return { path, cleanup: async () => { await unlink(path).catch(() => undefined); } };
        }
        catch (error) {
            await output?.close().catch(() => undefined);
            await unlink(path).catch(() => undefined);
            throw error;
        }
        finally {
            await pinned.close();
        }
    };
}
export function storedIndexSource(db, config) {
    const store = new Store(config.chunkRoot);
    const tempRoot = join(config.dataRoot, 'index-tmp');
    return async (file) => {
        await assertUnprotectedFile(db, file);
        const row = (await db.query(`SELECT v.chunk_collection_id,m.chunk_ids,m.total_size FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash WHERE v.id=$1`, [file.current_version_id])).rows[0];
        if (!row)
            throw new Error('Index source version has no manifest');
        const expectedSize = Number(row.total_size);
        if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_INDEX_SOURCE_BYTES)
            throw new Error('Index source exceeds the 2 GiB local extraction limit');
        const key = (await config.keyring.keys(row.chunk_collection_id)).data;
        await mkdir(tempRoot, { recursive: true, mode: 0o700 });
        const path = join(tempRoot, randomUUID());
        const output = await open(path, 'wx', 0o600);
        try {
            let total = 0;
            for (const id of row.chunk_ids) {
                const bytes = Buffer.from(await decryptChunk(await store.get(row.chunk_collection_id, id), key, id));
                total += bytes.byteLength;
                if (total > expectedSize || total > MAX_INDEX_SOURCE_BYTES)
                    throw new Error('Index source version exceeded its committed size');
                let offset = 0;
                while (offset < bytes.byteLength) {
                    const { bytesWritten } = await output.write(bytes, offset, bytes.byteLength - offset);
                    if (!bytesWritten)
                        throw new Error('Index source materialization made no write progress');
                    offset += bytesWritten;
                }
            }
            if (total !== expectedSize)
                throw new Error('Index source version did not match its committed size');
            await output.sync();
            await output.close();
            return { path, cleanup: async () => { await unlink(path).catch(() => undefined); } };
        }
        catch (error) {
            await output.close().catch(() => undefined);
            await unlink(path).catch(() => undefined);
            throw error;
        }
    };
}
