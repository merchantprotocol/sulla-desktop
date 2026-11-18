// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

const ROLES = ['owner', 'admin', 'member'] as const;

/** A directory entry after normalisation: always has userId and displayName, plus the optional fields the view reads. */
export interface NormalizedDirectoryPerson extends Record<string, unknown> {
  userId: string;
  displayName: string;
  agentHostOnline?: boolean;
  role?: string;
}

/**
 * Turns the org directory wire format into the People entries the view reads.
 * Production sends `{ id, name, agent_host_active }` (snake_case, 0/1). Newer hosts may send camelCase
 * fields, so both are accepted and camelCase wins when both are present. Roles come from memberships,
 * and a member without a known role gets no role, so the view shows no pill.
 */
export class DirectoryPersonNormalizer {
  normalize(raw: Record<string, unknown>): NormalizedDirectoryPerson {
    const userId = String(raw.userId ?? raw.id ?? '');
    const displayName = String(raw.displayName ?? raw.name ?? userId);
    const agentFlag = raw.agentHostOnline ?? raw.agent_host_active;
    const hasAgentFlag = typeof agentFlag === 'boolean' || agentFlag === 0 || agentFlag === 1;
    return { ...raw, userId, displayName, ...(hasAgentFlag ? { agentHostOnline: agentFlag === true || agentFlag === 1 } : {}) };
  }

  /** Normalises every entry and adds each member's role from the memberships read. Unknown roles are dropped. */
  withRoles(people: readonly Record<string, unknown>[], memberships: readonly { userId?: unknown; role?: unknown }[]): NormalizedDirectoryPerson[] {
    const roles = new Map<string, string>();
    for (const member of memberships) {
      if (typeof member.userId === 'string' && typeof member.role === 'string' && (ROLES as readonly string[]).includes(member.role)) {
        roles.set(member.userId, member.role);
      }
    }
    return people.map(raw => {
      const person = this.normalize(raw);
      const role = roles.get(person.userId);
      return role ? { ...person, role } : person;
    });
  }
}
