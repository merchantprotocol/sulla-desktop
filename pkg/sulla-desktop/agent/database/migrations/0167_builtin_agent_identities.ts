// SPDX-License-Identifier: GPL-2.0-or-later

import { BUILTIN_AGENT_RENAMES } from '../../../shared/agentJobNames';
import { hashManagedContent } from '../../builtinAgents';
import { rowToDefinition } from '../models/AgentDefinitionModel';

import type { PoolClient } from 'pg';

export class BuiltinAgentIdentityMigration {
  /** Preserve row IDs and captured job state. DatabaseManager runs this in a transaction. */
  async run(client: PoolClient): Promise<void> {
  const rows = (await client.query('SELECT * FROM agent_definitions FOR UPDATE')).rows.map(rowToDefinition);
  const bySlug = new Map(rows.map(row => [row.slug, row]));
  const renames = new Map<string, string>();
  const movedDefinitions = new Map<string, string>();
  for (const [oldSlug, slug] of BUILTIN_AGENT_RENAMES) {
    const row = bySlug.get(oldSlug);
    if (row?.is_builtin && !bySlug.has(slug)) {
      renames.set(oldSlug, slug);
      movedDefinitions.set(oldSlug, row.id);
    }
    // Copy the deletion marker too, so an intentionally removed agent stays removed.
    await client.query(`INSERT INTO agent_builtin_seed_ledger (slug)
      SELECT $2 FROM agent_builtin_seed_ledger WHERE slug = $1 ON CONFLICT (slug) DO NOTHING`, [oldSlug, slug]);
  }

  for (const row of rows) {
    const identity = row.is_builtin ? BUILTIN_AGENT_RENAMES.find(([previous]) => previous === row.slug) : undefined;
    const slug = renames.get(row.slug) ?? row.slug;
    const name = identity && row.name === identity[2] ? identity[3] : row.name;
    const canCall = row.can_call.map(callee => renames.get(callee) ?? callee);
    if (slug === row.slug && name === row.name && canCall.every((callee, i) => callee === row.can_call[i])) continue;

    // Re-stamp untouched rows so ordinary seeding can refresh managed prompts.
    const hash = row.is_builtin && row.builtin_hash === hashManagedContent(row)
      ? hashManagedContent({ ...row, slug, name, can_call: canCall }) : row.builtin_hash;
    await client.query('UPDATE agent_definitions SET slug = $2, name = $3, can_call = $4, builtin_hash = $5 WHERE id = $1',
      [row.id, slug, name, canCall, hash]);
  }

  if (renames.size === 0) return;
  for (const [old, slug] of renames) {
    await client.query("UPDATE sulla_settings SET value = $2 WHERE property = 'defaultAgentId' AND value = $1", [old, slug]);
  }
  const settings = (await client.query(`SELECT property, value FROM sulla_settings
    WHERE property IN ('modelRouting','modelDefaults') OR property LIKE 'productOwnerWorkflow.%' FOR UPDATE`)).rows;
  for (const { property, value } of settings) {
    let state: Record<string, any>;
    try { state = JSON.parse(value) } catch { continue }
    if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
    if (property === 'modelRouting') {
      for (const field of ['workerBindings', 'workerInheritance']) {
        const entries = state[field];
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
        for (const [old, slug] of renames) {
          if (entries[old]?.agentId !== movedDefinitions.get(old) || Object.prototype.hasOwnProperty.call(entries, slug)) continue;
          entries[slug] = entries[old];
          delete entries[old];
        }
      }
    } else if (property === 'modelDefaults') {
      for (const route of [state.chat, state.heartbeat]) {
        if (route?.kind === 'agent' && renames.has(route.agentId)) route.agentId = renames.get(route.agentId);
      }
    } else if (renames.has(state.agentSlug) && (!state.agentId || state.agentId === movedDefinitions.get(state.agentSlug))) {
      state.agentSlug = renames.get(state.agentSlug);
    }
    if (JSON.stringify(JSON.parse(value)) !== JSON.stringify(state)) {
      await client.query('UPDATE sulla_settings SET value = $2 WHERE property = $1', [property, JSON.stringify(state)]);
    }
  }
  }
}

export const up = (client: PoolClient) => new BuiltinAgentIdentityMigration().run(client);
