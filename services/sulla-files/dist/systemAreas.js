// SPDX-License-Identifier: GPL-2.0-or-later
import { randomUUID } from 'node:crypto';
const AREAS = [
    { key: 'logs', name: 'Logs', explorerPath: 'Logs', folders: ['audit/files', 'audit/vault', 'app'] },
    { key: 'training-data', name: 'Training Data', explorerPath: 'Training Data', folders: [] },
    { key: 'sulla', name: 'Sulla', explorerPath: 'Sulla', folders: ['Docs', 'Use Cases/skills', 'Use Cases/workflows', 'Use Cases/agents', 'Use Cases/functions', 'Use Cases/recipes', 'Projects', 'Identity'] },
];
export async function ensureSystemAreas(db, config) {
    if (!config.keyring?.unlocked)
        throw new Error('Files keyring must be unlocked before system areas are initialized');
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        for (const area of AREAS) {
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`system-area:${area.key}`]);
            let collection = (await client.query('SELECT * FROM collections WHERE system_area=$1', [area.key])).rows[0];
            if (!collection) {
                const id = randomUUID();
                collection = (await client.query(`INSERT INTO collections
          (id,org_id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,explorer_path,system_area)
          VALUES($1,$2,$3,$4,'knowledge','desktop-only',$5,$6,'{}',$8,$7) RETURNING *`, [id, config.orgId ?? null, config.userId, area.name, {}, {}, area.key, area.explorerPath])).rows[0];
                const wrapped = await config.keyring.create(id, client);
                await client.query('UPDATE collections SET encrypted_data_key=$2,dedup_key_ciphertext=$3 WHERE id=$1', [id, wrapped.data, wrapped.dedup]);
            }
            for (const folder of area.folders) {
                const parts = folder.split('/');
                for (let index = 1; index <= parts.length; index++) {
                    await client.query(`INSERT INTO file_folders(collection_id,path,created_by_type,created_by_id)
            VALUES($1,$2,'service','sulla-files') ON CONFLICT(collection_id,path) DO NOTHING`, [collection.id, parts.slice(0, index).join('/')]);
                }
            }
        }
        await client.query('COMMIT');
    }
    catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
    finally {
        client.release();
    }
}
/** Read-only system storage is structural: no caller grants can override it. */
export function assertSystemAreaWritable(area) {
    if (area === 'logs' || area === 'training-data') {
        throw Object.assign(new Error('System area is read-only'), { status: 403, code: 'EROFS' });
    }
}
