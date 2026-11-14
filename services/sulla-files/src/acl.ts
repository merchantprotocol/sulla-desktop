// Copyright © 2026 Merchant Protocol, LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type pg from 'pg';
import type { FilesIdentity } from './auth.js';

export type CollectionRole = 'view' | 'edit' | 'manage';
export interface CollectionAccess {
  role: CollectionRole;
  paths: { folderPath: string; role: string }[];
  files: { fileId: string; role: string }[];
  collection: any;
}

export const ROLE_LEVEL:Record<string, number> = { view: 1, edit: 2, manage: 3 };

/** Compares a caller's collection role with the level an action needs; an unknown role or right is refused. */
export class CollectionRoleGate {
  allows(role:string | undefined, right:string):boolean {
    if (!role || !Object.hasOwn(ROLE_LEVEL, role) || !Object.hasOwn(ROLE_LEVEL, right)) return false;
    return ROLE_LEVEL[role] >= ROLE_LEVEL[right];
  }
}

export async function resolveCollectionAccess(
  db:pg.Pool | pg.PoolClient,
  actor:FilesIdentity,
  collectionId:string,
):Promise<CollectionAccess> {
  const result = await db.query(
    'SELECT * FROM collections WHERE id=$1 AND published=TRUE AND legacy_source=FALSE',
    [collectionId],
  );
  const collection = result.rows[0];
  if (!collection) throw Object.assign(new Error('collection not found'), { status: 404 });

  return { role: 'manage', paths: [], files: [], collection };
}
