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

  async resolve(_actor:FilesIdentity, collectionId:string):Promise<CollectionAccess> {
    const collection = await this.collections.findAccessible(collectionId);
    if (!collection) throw Object.assign(new Error('collection not found'), { status: 404 });
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
