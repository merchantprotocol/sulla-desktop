import type { CapabilityClaims } from './auth.js';
import type pg from 'pg';

export const ROLE_LEVEL:Record<string, number> = { view: 1, 'use-by-agents': 2, edit: 3, manage: 4 };

export function groupPrincipals(identity:CapabilityClaims):string[] {
  return [...new Set([...(identity.group_ids ?? []), identity.org_id].filter((value):value is string => Boolean(value)))];
}

export async function accessibleCollectionIds(db:pg.Pool | pg.PoolClient, identity:CapabilityClaims, role = 'view'):Promise<string[]> {
  const required = (identity.agent_id || identity.job_id) && role === 'view' ? 'use-by-agents' : role;
  const groups = groupPrincipals(identity);
  const rows = await db.query(`SELECT a.collection_id,a.role FROM collection_acl a
    WHERE (a.principal_type='user' AND a.principal_id=$1)
       OR (a.principal_type='group' AND a.principal_id=ANY($2::text[]))`, [identity.sub, groups]);
  return rows.rows.filter((row:any) => ROLE_LEVEL[row.role] >= ROLE_LEVEL[required]).map((row:any) => row.collection_id);
}

export async function requireCollectionAccess(db:pg.Pool | pg.PoolClient, identity:CapabilityClaims, collectionId:string, role:string):Promise<void> {
  const ids = await accessibleCollectionIds(db, identity, role);
  if (!ids.includes(collectionId)) throw Object.assign(new Error('access denied'), { status: 403 });
}
