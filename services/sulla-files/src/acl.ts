// Copyright © 2026 Merchant Protocol, LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { FilesIdentity } from './auth.js';
import type pg from 'pg';

export type CollectionRole = 'view' | 'edit' | 'manage';
export interface CollectionAccess {
  role: CollectionRole;
  paths: { folderPath: string; role: string }[];
  files: { fileId: string; role: string }[];
  collection: any;
}

export const ROLE_LEVEL:Record<string, number> = { view: 1, edit: 2, manage: 3 };

export function organizationCollectionRole(roles:string[] = []):CollectionRole | undefined {
  if (roles.some(role => role === 'owner' || role === 'admin')) return 'manage';
  if (roles.includes('member')) return 'view';
  return undefined;
}

export function requireOrganizationScope(actor:FilesIdentity, orgId:string | null | undefined):void {
  if (actor.kind === 'server-session' && (!actor.orgId || actor.orgId !== orgId)) {
    throw Object.assign(new Error('organization access denied'), { status: 403 });
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

  if (actor.kind !== 'server-session') {
    return { role: 'manage', paths: [], files: [], collection };
  }

  requireOrganizationScope(actor, collection.org_id);
  if (collection.workspace_scope !== 'organization') {
    throw Object.assign(new Error('personal collections are not available in an organization workspace'), { status: 403 });
  }
  const role = organizationCollectionRole(actor.orgRoles);
  if (!role) throw Object.assign(new Error('organization access denied'), { status: 403 });
  return { role, paths: [], files: [], collection };
}
