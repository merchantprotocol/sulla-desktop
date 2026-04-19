/**
 * Observational Memory Section — Injects Sulla's persistent observations
 * (from SullaSettingsModel 'observationalMemory') so the active LLM has the
 * same durable "what I know about this user/business" context that the cloud
 * agent gets.
 *
 * Cache stability: 'stable' — the memory list only changes when the
 * subconscious observation agent writes a new entry or removes a stale one,
 * which is infrequent relative to the turn rate. Treating it as stable lets
 * Anthropic prompt caching keep it warm across turns.
 */

import { SullaSettingsModel } from '../../database/models/SullaSettingsModel';
import { parseJson } from '../../services/JsonParseService';
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

interface ObservationEntry {
  id?:        string;
  priority?:  string;
  timestamp?: string;
  content?:   string;
}

export async function buildObservationalMemorySection(
  _ctx: PromptBuildContext,
): Promise<PromptSection | null> {
  let entries: ObservationEntry[] = [];

  try {
    const raw = await SullaSettingsModel.get('observationalMemory', '[]');
    const parsed = parseJson(raw);
    if (Array.isArray(parsed)) {
      entries = parsed as ObservationEntry[];
    }
  } catch {
    // Treat unparseable memory as empty; don't block prompt assembly.
    entries = [];
  }

  if (entries.length === 0) return null;

  // Sort: high priority first, then recency within each priority bucket.
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

  const lines = entries.map((e) => {
    const id = e.id ? `[id:${ e.id }]` : '';
    const pri = e.priority ? ` ${ e.priority }` : '';
    const ts = e.timestamp ? ` ${ e.timestamp }` : '';
    const text = e.content ?? '';
    return `- ${ id }${ pri }${ ts } — ${ text }`.trim();
  });

  const content = `## Memory (persistent observations)

These are durable facts and preferences about the user and their business. Use them to stay consistent across turns. If a new observation should be stored or a stale one removed, call the appropriate Sulla tool:

\`\`\`bash
sulla meta/add_observational_memory '{"priority":"high","content":"…"}'
sulla meta/remove_observational_memory '{"id":"abcd"}'
\`\`\`

${ lines.join('\n') }`;

  return {
    id:             'observational_memory',
    content,
    priority:       45,
    cacheStability: 'stable',
  };
}
