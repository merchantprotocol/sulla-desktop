/**
 * Observational Memory Section — Injects a slim set of top-priority
 * observations into the system prompt so the active LLM has baseline
 * "what I know about this user/business" context.
 *
 * PRIMARY PATH: reads the top 10 critical/high-priority active rows from the
 * observations Postgres table (cheap direct query, no LLM involved).
 *
 * FALLBACK PATH: if the table is empty or unavailable (e.g. migration hasn't
 * run yet on this install), falls back to the legacy serialised JSON blob in
 * SullaSettingsModel 'observationalMemory'. This ensures back-compat during
 * the transition window.
 *
 * Full memory (all observations) is accessible via the observation-recall
 * subconscious agent or via the search_observations / list_observations tools.
 *
 * Cache stability: 'semi-stable' — top-N snapshot changes infrequently
 * relative to the turn rate, so it doesn't bust the stable prompt cache
 * on every turn.
 */

import { ObservationsModel } from '../../database/models/ObservationsModel';
import { SullaSettingsModel } from '../../database/models/SullaSettingsModel';
import { parseJson } from '../../services/JsonParseService';

import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

/** Max observations to inject into the system prompt. */
const TOP_N = 10;

interface ObservationEntry {
  id?:        string;
  priority?:  string;
  timestamp?: string;
  content?:   string;
}

export async function buildObservationalMemorySection(
  _ctx: PromptBuildContext,
): Promise<PromptSection | null> {
  // ── PRIMARY PATH: read from observations table ────────────────────────
  try {
    const rows = await ObservationsModel.listActive(undefined, TOP_N);

    if (rows.length > 0) {
      const lines = rows.map((r) =>
        `- [id:${ r.id }] ${ r.priority } ${ r.created_at.slice(0, 10) } — ${ r.content }`.trim(),
      );

      const content = `## Memory (top-${ TOP_N } observations)

Critical and high-priority facts about the user and their business. Full memory is searchable via \`search_observations\` / \`list_observations\` tools. To add, update, or archive observations, call the matching memory/observation tool exposed in your tool list. When updating an existing observation, pass its \`id\` to \`add_observational_memory\`.

${ lines.join('\n') }`;

      return {
        id:             'observational_memory',
        content,
        priority:       45,
        cacheStability: 'semi-stable',
      };
    }
    // Table exists but is empty — fall through to legacy fallback.
  } catch {
    // Table may not exist yet (migration pending). Fall through to legacy.
  }

  // ── LEGACY FALLBACK: serialised JSON blob in SullaSettingsModel ───────
  let entries: ObservationEntry[] = [];
  try {
    const raw = await SullaSettingsModel.get('observationalMemory', '[]');
    const parsed = parseJson(raw);
    if (Array.isArray(parsed)) {
      entries = parsed as ObservationEntry[];
    }
  } catch {
    entries = [];
  }

  if (entries.length === 0) return null;

  // Sort: high priority first, then recency.
  const priorityRank = (p: string | undefined) => {
    switch ((p ?? '').toLowerCase()) {
    case 'critical':
    case 'high':
      return 0;
    case 'medium':
      return 1;
    case 'low':
      return 2;
    default:
      return 3;
    }
  };
  entries.sort((a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    return String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? ''));
  });

  // Cap legacy fallback at TOP_N too.
  const topEntries = entries.slice(0, TOP_N);
  const lines = topEntries.map((e) => {
    const id = e.id ? `[id:${ e.id }]` : '';
    const pri = e.priority ? ` ${ e.priority }` : '';
    const ts = e.timestamp ? ` ${ e.timestamp }` : '';
    const text = e.content ?? '';
    return `- ${ id }${ pri }${ ts } — ${ text }`.trim();
  });

  const content = `## Memory (persistent observations — legacy)

These are durable facts about the user and their business. Use them to stay consistent across turns. If a new observation should be stored, an existing one updated, or a stale one archived, call the matching memory/observation tool exposed in your tool list. When updating an existing observation, pass its \`id\` to \`add_observational_memory\`.

${ lines.join('\n') }`;

  return {
    id:             'observational_memory',
    content,
    priority:       45,
    cacheStability: 'semi-stable',
  };
}
