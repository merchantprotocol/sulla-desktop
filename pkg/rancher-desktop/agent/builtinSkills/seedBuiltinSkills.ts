/**
 * seedBuiltinSkills — boot-time installer for the skills that ship with Sulla.
 *
 * Same contract as seedBuiltinAgents. Runs every boot, idempotent, never
 * deletes, never clobbers a human edit:
 *   - missing slug, never seen on this install    → insert (source_kind builtin)
 *   - missing slug, seen before (human removed it) → leave it gone
 *   - soft-deleted row                             → leave it deleted
 *   - built-in row untouched since the last seed   → refresh to the bundle
 *   - built-in row the human edited                → keep their content
 *   - other row identical to the bundle            → adopt as built-in
 *   - any other existing row                       → keep its content
 *
 * "Untouched" means the row's live content still hashes to the source_hash the
 * seeder last wrote, so edits from any path (tools, UI, SQL) are detected
 * without hooks. enabled always stays the human's.
 *
 * Non-fatal by contract: callers wrap it; a failure re-seeds next boot.
 */

import { getBuiltinSkillSpecs, getRetiredBuiltinSkillSlugs, renderBuiltinSkill, type BuiltinSkillSpec } from './index';
import { postgresClient } from '../database/PostgresClient';
import { SkillDefinitionModel, type SkillContent, type SkillDefinition } from '../database/models/SkillDefinitionModel';
import { hashSkillContent } from '../services/SkillDefinitionService';

export type BuiltinSkillSeedAction = 'insert' | 'deleted-by-human' | 'unchanged' | 'stamp' | 'refresh' | 'adopt' | 'kept';

/** Pure decision for one bundled skill. Exported for tests. */
export function decideBuiltinSkillSeedAction(content: SkillContent, row: SkillDefinition | null, seenBefore: boolean): BuiltinSkillSeedAction {
  if (!row) return seenBefore ? 'deleted-by-human' : 'insert';
  if (row.deleted_at) return 'deleted-by-human';

  const bundleHash = hashSkillContent(content);
  const liveHash = hashSkillContent(row);

  if (row.source_kind === 'builtin') {
    if (liveHash === bundleHash) return row.source_hash === bundleHash ? 'unchanged' : 'stamp';
    if (row.source_hash && liveHash === row.source_hash) return 'refresh';
    return 'kept';
  }

  // A row this install already had (folder import, hand-made, older build).
  // Adopt it only when it is exactly the bundled content.
  return liveHash === bundleHash ? 'adopt' : 'kept';
}

async function seenSlugs(): Promise<Set<string>> {
  const rows = await postgresClient.query('SELECT slug FROM skill_builtin_seed_ledger', []);
  return new Set(rows.map((row: { slug: string }) => row.slug));
}

async function markSeen(slug: string): Promise<void> {
  await postgresClient.query('INSERT INTO skill_builtin_seed_ledger (slug) VALUES ($1) ON CONFLICT (slug) DO NOTHING', [slug]);
}

export interface BuiltinSkillSeedSummary {
  inserted:  number;
  refreshed: number;
  adopted:   number;
  kept:      number;
  unchanged: number;
  skipped:   number;
  errors:    string[];
}

export async function seedBuiltinSkills(specs: BuiltinSkillSpec[] = getBuiltinSkillSpecs()): Promise<BuiltinSkillSeedSummary> {
  const summary: BuiltinSkillSeedSummary = { inserted: 0, refreshed: 0, adopted: 0, kept: 0, unchanged: 0, skipped: 0, errors: [] };
  const seen = await seenSlugs();

  for (const spec of specs) {
    try {
      const content = renderBuiltinSkill(spec);
      const bundleHash = hashSkillContent(content);
      const row = await SkillDefinitionModel.findBySlug(spec.slug);
      const action = decideBuiltinSkillSeedAction(content, row, seen.has(spec.slug));
      const stamp = { sourceKind: 'builtin' as const, sourceHash: bundleHash, contentHash: bundleHash };

      switch (action) {
      case 'insert':
        await SkillDefinitionModel.create({ slug: spec.slug, ...content, ...stamp, sourcePath: null, enabled: true });
        summary.inserted++;
        break;
      case 'refresh':
        // Compare-and-set: a human edit that lands mid-boot wins.
        if (await SkillDefinitionModel.update(row!.id, { ...content, ...stamp }, row!.updated_at)) summary.refreshed++;
        else summary.kept++;
        break;
      case 'adopt':
      case 'stamp':
        if (await SkillDefinitionModel.update(row!.id, stamp, row!.updated_at)) {
          if (action === 'adopt') summary.adopted++;
          else summary.unchanged++;
        } else summary.kept++;
        break;
      case 'kept': summary.kept++; break;
      case 'unchanged': summary.unchanged++; break;
      case 'deleted-by-human': summary.skipped++; break;
      }

      await markSeen(spec.slug);
    } catch (error) {
      summary.errors.push(`${ spec.slug }: ${ error instanceof Error ? error.message : String(error) }`);
    }
  }

  return summary;
}

/** Ledger key recording that a retirement was handled, so it runs once per install. */
export function retiredSkillLedgerKey(slug: string): string {
  return `retired:${ slug }`;
}

/**
 * Disable built-ins the bundle no longer ships (bundle "retired" list), once,
 * and only while the seeder still owns them (untouched since the last seed).
 * Never deletes.
 */
export async function retireBuiltinSkills(slugs: string[] = getRetiredBuiltinSkillSlugs()): Promise<{ disabled: number; errors: string[] }> {
  const summary = { disabled: 0, errors: [] as string[] };
  if (!slugs.length) return summary;
  const seen = await seenSlugs();
  for (const slug of slugs) {
    try {
      const key = retiredSkillLedgerKey(slug);
      if (seen.has(key)) continue;
      const row = await SkillDefinitionModel.findBySlug(slug);
      const owned = row && row.source_kind === 'builtin' && row.enabled && !row.deleted_at && row.source_hash && hashSkillContent(row) === row.source_hash;
      if (owned && await SkillDefinitionModel.update(row.id, { enabled: false }, row.updated_at)) summary.disabled++;
      await markSeen(key);
    } catch (error) {
      summary.errors.push(`${ slug }: ${ error instanceof Error ? error.message : String(error) }`);
    }
  }
  return summary;
}
