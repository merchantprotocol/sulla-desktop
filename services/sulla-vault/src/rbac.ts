import type { Queryable } from './db.js';

export type CollectionRight = 'view' | 'useByAgents' | 'edit' | 'manage';
export type OrgRole = 'owner' | 'admin' | 'member';

export class AccessDenied extends Error {
  constructor(message = 'Collection access denied') {
    super(message);
    this.name = 'AccessDenied';
  }
}

interface CollectionAccessRow {
  role:              'owner' | 'admin' | 'member' | null;
  can_view:          boolean | null;
  can_use_by_agents: boolean | null;
  can_edit:          boolean | null;
  can_manage:        boolean | null;
}

export async function requireCollectionRight(
  db: Queryable,
  userId: string,
  collectionId: string,
  right: CollectionRight,
): Promise<void> {
  const result = await db.query<CollectionAccessRow>(
    `SELECT om.role,
            (cm.can_view OR EXISTS (SELECT 1 FROM group_members gm JOIN collection_group_members cgm ON cgm.group_id = gm.group_id WHERE gm.user_id = $1 AND cgm.collection_id = c.id AND cgm.can_view)) AS can_view,
            (cm.can_use_by_agents OR EXISTS (SELECT 1 FROM group_members gm JOIN collection_group_members cgm ON cgm.group_id = gm.group_id WHERE gm.user_id = $1 AND cgm.collection_id = c.id AND cgm.can_use_by_agents)) AS can_use_by_agents,
            (cm.can_edit OR EXISTS (SELECT 1 FROM group_members gm JOIN collection_group_members cgm ON cgm.group_id = gm.group_id WHERE gm.user_id = $1 AND cgm.collection_id = c.id AND cgm.can_edit)) AS can_edit,
            (cm.can_manage OR EXISTS (SELECT 1 FROM group_members gm JOIN collection_group_members cgm ON cgm.group_id = gm.group_id WHERE gm.user_id = $1 AND cgm.collection_id = c.id AND cgm.can_manage)) AS can_manage
       FROM collections c
       LEFT JOIN org_members om ON om.org_id = c.org_id AND om.user_id = $1
       LEFT JOIN collection_members cm ON cm.collection_id = c.id AND cm.user_id = $1
      WHERE c.id = $2`,
    [userId, collectionId],
  );
  const access = result.rows[0];
  if (!access) {
    throw new AccessDenied();
  }
  if (access.role === 'owner' || access.role === 'admin') {
    return;
  }
  const column: Record<CollectionRight, keyof CollectionAccessRow> = {
    view:        'can_view',
    useByAgents: 'can_use_by_agents',
    edit:        'can_edit',
    manage:      'can_manage',
  };
  if (access.role !== 'member' || access[column[right]] !== true) {
    throw new AccessDenied();
  }
}

export async function getOrgRole(db: Queryable, userId: string, orgId: string): Promise<OrgRole | undefined> {
  const result = await db.query<{ role: OrgRole }>(
    'SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2',
    [orgId, userId],
  );
  return result.rows[0]?.role;
}

export async function requireOrgManager(db: Queryable, userId: string, orgId: string): Promise<OrgRole> {
  const role = await getOrgRole(db, userId, orgId);
  if (role !== 'owner' && role !== 'admin') {
    throw new AccessDenied('Organization management access denied');
  }
  return role;
}
