/**
 * Shared validation for anything that writes Reflex training examples
 * (reflex_teach, reflex_correct, the post-turn Reflex Trainer).
 */

import { ReflexModel, type ReflexExampleRow } from '../database/models/ReflexModel';
import { toolRegistry } from '../tools/registry';

import { REFLEX_NONE } from './ReflexEngine';
import { reflexPolicyViolation } from './reflexPolicy';
import { getReflexSettings, toolCategory } from './ReflexService';

export interface RawExample {
  utterance?: unknown;
  tool?:      unknown;
  params?:    unknown;
  positive?:  unknown;
}

/** Accepts "tab", "browser/tab", or "sulla browser/tab". */
export function normalizeToolName(raw: string): string {
  const cleaned = raw.trim().replace(/^sulla\s+/, '');
  if (cleaned === REFLEX_NONE) return REFLEX_NONE;
  const slash = cleaned.lastIndexOf('/');
  return slash >= 0 ? cleaned.slice(slash + 1) : cleaned;
}

export async function teachExample(
  raw: RawExample,
  meta: { source: string; threadId?: string | null },
): Promise<{ ok: true; row: ReflexExampleRow; created: boolean } | { ok: false; error: string }> {
  const utterance = typeof raw.utterance === 'string' ? raw.utterance.trim() : '';
  if (!utterance) return { ok: false, error: 'utterance is required' };
  if (typeof raw.tool !== 'string' || !raw.tool.trim()) return { ok: false, error: 'tool is required (a Sulla tool name, or "none")' };

  const toolName = normalizeToolName(raw.tool);
  const positive = raw.positive !== false && raw.positive !== 'false';
  let params: Record<string, unknown> = {};
  if (typeof raw.params === 'string' && raw.params.trim()) {
    try { params = JSON.parse(raw.params) } catch { return { ok: false, error: 'params must be a JSON object' } }
  } else if (raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)) {
    params = raw.params as Record<string, unknown>;
  }

  if (toolName !== REFLEX_NONE) {
    const category = toolCategory(toolName);
    if (!category) return { ok: false, error: `unknown tool "${ raw.tool }" — use the registry name, e.g. "tab" for browser/tab` };
    // Only positive examples can make Reflex act, so only they need the policy.
    if (positive) {
      const { allowedCategories } = await getReflexSettings();
      const violation = reflexPolicyViolation({ toolName, category, params, allowedCategories });
      if (violation) return { ok: false, error: violation };
    }
    try {
      const tool = await toolRegistry.createTool(toolName);
      params = (tool as any).parseInput(params);
    } catch (err) {
      return { ok: false, error: `params do not fit ${ toolName }: ${ err instanceof Error ? err.message : err }` };
    }
  } else {
    params = {};
  }

  const { row, created } = await ReflexModel.teach({ utterance, toolName, params, positive, source: meta.source, threadId: meta.threadId });
  return { ok: true, row, created };
}
