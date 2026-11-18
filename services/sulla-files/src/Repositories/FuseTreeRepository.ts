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
      marked AS (INSERT INTO fuse_change_retention(collection_id,pruned_through,pruned_xid)
        SELECT e.collection_id,e.through_id,COALESCE((SELECT MAX(xid) FROM fuse_change_journal j WHERE j.collection_id=e.collection_id AND j.id<=e.through_id),pg_current_xact_id()) FROM expired e
        ON CONFLICT(collection_id) DO UPDATE SET pruned_through=GREATEST(fuse_change_retention.pruned_through,EXCLUDED.pruned_through),
          pruned_xid=GREATEST(fuse_change_retention.pruned_xid,EXCLUDED.pruned_xid) RETURNING collection_id)
      DELETE FROM fuse_change_journal j USING expired_rows x,marked m WHERE j.ctid=x.ctid AND m.collection_id=x.collection_id`);
  }

  /** Bounded path changes use a PostgreSQL snapshot so xid commit order cannot skip lower journal ids. */
  async changes(collectionId:string, since:string):Promise<{cursor:string; reset:boolean; more:boolean; changes:any[]}> {
    // Polling adapters share one bounded prune attempt per process, not one DELETE per poll.
    if (Date.now() - this.lastPruneAt >= 30_000) {
      this.lastPruneAt = Date.now();
      await this.pruneExpired();
    }
    const legacy = /^\d+$/.test(since);
    const valid = /^\d+:\d+:\d*(?:,\d+)*$/.test(since);
    const snap = `pg_current_snapshot()::text`;
    if (!valid || legacy) {
      const current=String((await this.db.query(`SELECT ${snap} AS cursor`)).rows[0].cursor);
      return { cursor:current, reset:true, more:false, changes:[] };
    }
    const rows=(await this.db.query(`WITH s AS MATERIALIZED (SELECT ${snap} AS cursor), r AS (
      SELECT pruned_xid FROM fuse_change_retention WHERE collection_id=$1
    ) SELECT s.cursor,r.pruned_xid::text AS "prunedXid",pg_snapshot_xmin($2::pg_snapshot)::text AS "cursorXmin",
      j.path,j.old_path AS "oldPath",j.kind,j.current_version_id::text AS "versionId",j.size,j.id
      FROM s LEFT JOIN r ON TRUE LEFT JOIN LATERAL (
        SELECT id,path,old_path,kind,current_version_id,size FROM fuse_change_journal
        WHERE collection_id=$1 AND xid >= pg_snapshot_xmin($2::pg_snapshot)
          AND NOT pg_visible_in_snapshot(xid,$2::pg_snapshot) ORDER BY id LIMIT 1001
      ) j ON TRUE`,[collectionId,since])).rows;
    const state=rows[0];
    const shouldReset=state.prunedXid && BigInt(state.prunedXid)>=BigInt(state.cursorXmin);
    if(shouldReset) return {cursor:String(state.cursor),reset:true,more:false,changes:[]};
    const changes=rows.filter((row:any)=>row.id!==null);
    const more = changes.length > 1000; const page = more ? changes.slice(0,1000) : changes;
    // A single create can journal both insert and current-version update in one
    // transaction. Return one event per path in this page, with the latest kind.
    const byPath = new Map<string, any>();
    for (const { id: _id, ...change } of page as any[]) {
      const previous = byPath.get(change.path);
      const membershipKind = ['insert','delete','rename'].includes(change.kind)
        ? change.kind : previous?.membershipKind;
      byPath.set(change.path, {
        ...change,
        oldPath: change.oldPath ?? previous?.oldPath ?? null,
        membershipKind,
        kind: membershipKind ?? 'update',
      });
    }
    return { cursor:String(state.cursor), reset:more, more:false, changes:more ? [] : [...byPath.values()].map(({membershipKind: _membershipKind, ...change}) => change) };
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
