// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** One consistent read of the mounted tree, labelled with the revision it represents. */
export interface FuseTreeRows { revision:string; collections:any[]; files:any[]; folders:any[] }

/** Reads behind the Files mount (FUSE): the change revision, the whole home tree, one directory and one entry. */
export class FuseTreeRepository {
  private lastPruneAt = 0;
  constructor(private readonly db:Pick<pg.Pool, 'query' | 'connect'>) {}

  /** The database-owned change marker every mount cache keys on. */
  async revision():Promise<string> {
    return String((await this.db.query('SELECT revision FROM fuse_tree_state WHERE singleton=TRUE')).rows[0]?.revision ?? '0');
  }

  /** One bounded, unthrottled prune of journal rows older than 10 minutes; advances pruned_through so stale cursors reset. */
  async pruneExpired():Promise<void> {
    await this.db.query(`WITH expired_rows AS (SELECT ctid,collection_id,id FROM fuse_change_journal WHERE changed_at < now()-interval '10 minutes' ORDER BY id LIMIT 1000),
      expired AS (SELECT collection_id,MAX(id) AS through_id FROM expired_rows GROUP BY collection_id),
      marked AS (INSERT INTO fuse_change_retention(collection_id,pruned_through) SELECT collection_id,through_id FROM expired
        ON CONFLICT(collection_id) DO UPDATE SET pruned_through=GREATEST(fuse_change_retention.pruned_through,EXCLUDED.pruned_through) RETURNING collection_id)
      DELETE FROM fuse_change_journal j USING expired_rows x,marked m WHERE j.ctid=x.ctid AND m.collection_id=x.collection_id`);
  }

  /** Bounded path changes for one authorized collection; cursors are journal ids, not global revisions. */
  async changes(collectionId:string, since:string):Promise<{cursor:string; reset:boolean; more:boolean; changes:{path:string;oldPath:string|null;kind:string}[]}> {
    // Polling adapters share one bounded prune attempt per process, not one DELETE per poll.
    if (Date.now() - this.lastPruneAt >= 30_000) {
      this.lastPruneAt = Date.now();
      await this.pruneExpired();
    }
    // A sequence id is allocated at INSERT, not COMMIT. Exclude transactions that
    // could still commit below a later id returned to this reader.
    const visible = 'xid < pg_snapshot_xmin(pg_current_snapshot())';
    const bounds = (await this.db.query(`SELECT COALESCE(MIN(j.id),0)::text AS oldest,COALESCE(MAX(j.id),0)::text AS newest,
      COALESCE(r.pruned_through,0)::text AS pruned FROM fuse_change_retention r FULL JOIN fuse_change_journal j ON j.collection_id=r.collection_id
      WHERE COALESCE(r.collection_id,j.collection_id)=$1 AND (j.id IS NULL OR j.${visible}) GROUP BY r.pruned_through`, [collectionId])).rows[0] ?? { oldest:'0',newest:'0',pruned:'0' };
    const numericSince = /^\d+$/.test(since) ? BigInt(since) : null;
    const valid = numericSince !== null && numericSince <= 9223372036854775807n;
    const cursor = valid ? numericSince! : 0n;
    const oldest = BigInt(bounds.oldest); const newest = BigInt(bounds.newest);
    if (!valid || cursor < BigInt(bounds.pruned) || (oldest > 0n && cursor < oldest - 1n)) return { cursor: (newest > BigInt(bounds.pruned) ? newest : BigInt(bounds.pruned)).toString(), reset: true, more: false, changes: [] };
    const rows = (await this.db.query(`SELECT id::text AS id,path,old_path AS "oldPath",kind FROM fuse_change_journal WHERE collection_id=$1 AND id>$2 AND ${visible} ORDER BY id LIMIT 1001`, [collectionId, since])).rows;
    const more = rows.length > 1000; const page = more ? rows.slice(0,1000) : rows;
    // A single create can journal both insert and current-version update in one
    // transaction. Return one event per path in this page, with the latest kind.
    const byPath = new Map<string, {path:string;oldPath:string|null;kind:string}>();
    for (const { id: _id, ...change } of page as any[]) {
      const previous = byPath.get(change.path);
      byPath.set(change.path, {
        ...change,
        oldPath: change.oldPath ?? previous?.oldPath ?? null,
      });
    }
    return { cursor: page.at(-1)?.id ?? since, reset: false, more, changes: [...byPath.values()] };
  }

  async homeCollectionId(userId:string):Promise<string> {
    return String((await this.db.query(`SELECT h.id FROM collections h WHERE h.owner_user_id=$1 AND h.system_area IS NULL AND h.published=TRUE AND h.legacy_source=FALSE ORDER BY EXISTS(SELECT 1 FROM collection_acl a WHERE a.collection_id=h.id AND a.principal_type='user' AND a.principal_id=$1 AND a.role='manage') DESC,h.is_default DESC,h.created_at LIMIT 1`, [userId])).rows[0]?.id ?? '');
  }

  /**
   * The home (area '') or a system area's collections, live files and folders, read in one
   * REPEATABLE READ READ ONLY snapshot so active ingestion cannot starve or tear it.
   */
  async snapshot(area:string, userId:string):Promise<FuseTreeRows> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const revision = String((await client.query('SELECT revision FROM fuse_tree_state WHERE singleton=TRUE')).rows[0].revision);
      const [collections, files, folders] = await Promise.all([
        client.query(`SELECT id,name,CASE WHEN c.workspace_scope='organization' AND EXISTS(SELECT 1 FROM collections sibling WHERE sibling.workspace_scope='organization' AND sibling.org_id=c.org_id AND sibling.owner_user_id=c.owner_user_id AND sibling.org_collection_enrolled=TRUE AND sibling.org_collection_level<>'none' AND sibling.id<>c.id AND CASE WHEN sibling.explorer_path LIKE '% ('||LEFT(sibling.id::text,8)||')' THEN LEFT(sibling.explorer_path,LENGTH(sibling.explorer_path)-11) ELSE sibling.explorer_path END=CASE WHEN c.explorer_path LIKE '% ('||LEFT(c.id::text,8)||')' THEN LEFT(c.explorer_path,LENGTH(c.explorer_path)-11) ELSE c.explorer_path END) THEN (CASE WHEN c.explorer_path LIKE '% ('||LEFT(c.id::text,8)||')' THEN LEFT(c.explorer_path,LENGTH(c.explorer_path)-11) ELSE c.explorer_path END)||' ('||LEFT(c.id::text,8)||')' ELSE CASE WHEN c.explorer_path LIKE '% ('||LEFT(c.id::text,8)||')' THEN LEFT(c.explorer_path,LENGTH(c.explorer_path)-11) ELSE c.explorer_path END END AS tree_path,is_default,system_area AS "systemArea",workspace_scope AS "workspaceScope",org_id AS "orgId",org_name AS "orgName",org_collection_level AS level,description,naming_hint FROM collections c WHERE published=TRUE AND legacy_source=FALSE AND (($1='' AND c.id=(SELECT h.id FROM collections h WHERE h.owner_user_id=$2 AND h.system_area IS NULL AND h.workspace_scope='principal' AND h.published=TRUE AND h.legacy_source=FALSE ORDER BY EXISTS(SELECT 1 FROM collection_acl a WHERE a.collection_id=h.id AND a.principal_type='user' AND a.principal_id=$2 AND a.role='manage') DESC,h.is_default DESC,h.created_at LIMIT 1)) OR c.system_area=$1 OR ($1='' AND c.workspace_scope='organization' AND c.owner_user_id=$2 AND c.org_collection_enrolled=TRUE AND c.org_collection_level<>'none'))
            AND (kind<>'scratch' OR EXISTS(SELECT 1 FROM files f WHERE f.collection_id=c.id AND f.deleted_at IS NULL) OR EXISTS(SELECT 1 FROM file_folders d WHERE d.collection_id=c.id AND d.deleted_at IS NULL))
            ORDER BY CASE WHEN workspace_scope='principal' THEN 0 ELSE 1 END,explorer_path,id`, [area, userId]),
        client.query(`SELECT f.id,f.collection_id,f.path,f.mime,f.size,f.updated_at,
            f.current_version_id AS "versionId" FROM files f JOIN collections c ON c.id=f.collection_id
            WHERE (($1='' AND c.id=(SELECT h.id FROM collections h WHERE h.owner_user_id=$2 AND h.system_area IS NULL AND h.workspace_scope='principal' AND h.published=TRUE AND h.legacy_source=FALSE ORDER BY EXISTS(SELECT 1 FROM collection_acl a WHERE a.collection_id=h.id AND a.principal_type='user' AND a.principal_id=$2 AND a.role='manage') DESC,h.is_default DESC,h.created_at LIMIT 1)) OR c.system_area=$1 OR ($1='' AND c.workspace_scope='organization' AND c.owner_user_id=$2 AND c.org_collection_enrolled=TRUE AND c.org_collection_level<>'none')) AND f.deleted_at IS NULL AND (lower(f.path) !~ '(^|/)(master[.]key|wallet|vault|vaults)($|/)' OR (c.system_area='logs' AND f.path ~ '^audit/(files|vault)/[A-Za-z0-9_-]+[.]jsonl$')) AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)
            ORDER BY f.collection_id,f.path`, [area, userId]),
        client.query(`SELECT d.id,d.collection_id,d.path,d.description,d.naming_hint,(d.description LIKE 'Created by % — needs description') AS needs_description FROM file_folders d JOIN collections c ON c.id=d.collection_id WHERE (($1='' AND c.id=(SELECT h.id FROM collections h WHERE h.owner_user_id=$2 AND h.system_area IS NULL AND h.workspace_scope='principal' AND h.published=TRUE AND h.legacy_source=FALSE ORDER BY EXISTS(SELECT 1 FROM collection_acl a WHERE a.collection_id=h.id AND a.principal_type='user' AND a.principal_id=$2 AND a.role='manage') DESC,h.is_default DESC,h.created_at LIMIT 1)) OR c.system_area=$1 OR ($1='' AND c.workspace_scope='organization' AND c.owner_user_id=$2 AND c.org_collection_enrolled=TRUE AND c.org_collection_level<>'none')) AND d.deleted_at IS NULL ORDER BY d.collection_id,d.path`, [area, userId]),
      ]);
      await client.query('COMMIT');
      return { revision, collections: collections.rows, files: files.rows, folders: folders.rows };
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  /** A page of one directory's live direct children (files and folders) after the cursor path; the caller asks for limit+1. */
  async directoryPage(collectionId:string, path:string, cursor:string, limit:number):Promise<any[]> {
    return (await this.db.query(`SELECT * FROM (
      SELECT 'file' AS kind,f.id,f.collection_id,f.path,f.mime,f.size,f.updated_at,f.current_version_id::text AS "versionId"
        FROM files f JOIN collections c ON c.id=f.collection_id
        WHERE f.collection_id=$1 AND f.parent_path=$2 AND f.deleted_at IS NULL
          AND (lower(f.path) !~ '(^|/)(master[.]key|wallet|vault|vaults)($|/)' OR (c.system_area='logs' AND f.path ~ '^audit/(files|vault)/[A-Za-z0-9_-]+[.]jsonl$'))
          AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)
      UNION ALL
      SELECT 'directory' AS kind,d.id,d.collection_id,d.path,NULL::text AS mime,0::bigint AS size,d.updated_at,NULL::text AS "versionId"
        FROM file_folders d JOIN collections c ON c.id=d.collection_id
        WHERE d.collection_id=$1 AND d.parent_path=$2 AND d.deleted_at IS NULL
    ) direct_children WHERE path>$3 ORDER BY path LIMIT $4`, [collectionId, path, cursor, limit])).rows;
  }

  /** The live file or folder at exactly this path. */
  async entry(collectionId:string, path:string):Promise<any | undefined> {
    return (await this.db.query(`SELECT * FROM (
      SELECT 'file' AS kind,f.id,f.collection_id,f.path,f.mime,f.size,f.updated_at,f.current_version_id::text AS "versionId" FROM files f JOIN collections c ON c.id=f.collection_id
      WHERE f.collection_id=$1 AND f.path=$2 AND f.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)
        AND (lower(f.path) !~ '(^|/)(master[.]key|wallet|vault|vaults)($|/)' OR (c.system_area='logs' AND f.path ~ '^audit/(files|vault)/[A-Za-z0-9_-]+[.]jsonl$'))
      UNION ALL SELECT 'directory' AS kind,d.id,d.collection_id,d.path,NULL::text AS mime,0::bigint AS size,d.updated_at,NULL::text AS "versionId" FROM file_folders d WHERE d.collection_id=$1 AND d.path=$2 AND d.deleted_at IS NULL
    ) entry LIMIT 1`, [collectionId, path])).rows[0];
  }
}
