// Copyright © 2026 Merchant Protocol, LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { CollectionAccessRepository } from './Repositories/CollectionAccessRepository.js';

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

/** Resolves what a caller may do in a collection. Today every published, non-legacy collection is the owner's: manage. */
export class CollectionAccessResolver {
  constructor(private readonly collections:CollectionAccessRepository) {}

  async resolve(actor:FilesIdentity, collectionId:string):Promise<CollectionAccess> {
    const collection = await this.collections.findAccessible(collectionId);
    if (!collection) throw Object.assign(new Error('collection not found'), { status: 404 });
    if (collection.workspace_scope === 'organization') {
      if (!collection.org_collection_enrolled || collection.owner_user_id !== actor.userId || collection.org_collection_level === 'none') throw Object.assign(new Error('access denied'), { status: 403 });
      if(actor.agentId||actor.jobId) {
        if(actor.collectionId&&actor.collectionId!==collectionId) throw Object.assign(new Error('agent collection policy denied access'),{status:403});
        if(!await this.collections.agentCanUse(collectionId,actor.userId,actor.groupIds??[])) throw Object.assign(new Error('agent access denied'),{status:403});
        const role=collection.org_collection_level==='manage'?'edit':collection.org_collection_level;
        return { role, paths: [], files: [], collection };
      }
      return { role: collection.org_collection_level, paths: [], files: [], collection };
    }
    return { role: 'manage', paths: [], files: [], collection };
  }
}

/** Delegating shim for app.ts: builds the resolver from the passed-in pool or transaction client. */
export function resolveCollectionAccess(
  db:pg.Pool | pg.PoolClient,
  actor:FilesIdentity,
  collectionId:string,
):Promise<CollectionAccess> {
  return new CollectionAccessResolver(new CollectionAccessRepository(db)).resolve(actor, collectionId);
}
