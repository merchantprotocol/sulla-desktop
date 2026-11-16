// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { MODEL_CLASSES, type AgentModelChoice } from './modelRoutingTypes';

/** True when `value` is a well-formed AgentModelChoice (list, a known class, or a provider + model pin). */
export function isAgentModelChoice(value: unknown): value is AgentModelChoice {
  const v = value as Record<string, unknown> | null | undefined;
  if (!v || typeof v !== 'object') return false;
  if (v.mode === 'list') return true;
  if (v.mode === 'class') return MODEL_CLASSES.includes(v.class as any);
  return v.mode === 'pin' && typeof v.provider === 'string' && !!v.provider.trim() && typeof v.model === 'string' && !!v.model.trim();
}

/**
 * The model choice for one turn of a thread. A choice stored on the thread (a Defaults "Model" pick for
 * new chats or the heartbeat) overrides the agent's own Model setting without changing that agent.
 */
export function threadModelChoice(metadata: unknown, fallback: AgentModelChoice = { mode: 'list' }): AgentModelChoice {
  const value = (metadata as { modelChoice?: unknown } | null | undefined)?.modelChoice;
  return isAgentModelChoice(value) ? value : fallback;
}

/** Slot aliases an agent's `model` field may hold; they are not exact model ids. */
const SLOT_ALIASES = ['primary', 'secondary', 'subconscious'];

/**
 * The model choice one turn uses. Precedence: an explicit per-task pin (provider + exact model on the
 * turn's agent config) > the thread's model choice > the agent's own Model setting > the list.
 */
/**
 * The subscription provider an exact model id belongs to, for a task that named a model but no
 * provider. Without this the model was silently dropped and the agent ran on its own default
 * (a "Fable" review ran on Opus, 2026-11-14). Unknown names return '' and keep the old behavior.
 */
export function providerForModelId(model: string): string {
  const id = model.trim().toLowerCase();
  if (/^claude-[a-z]+-\d/.test(id)) return 'claude-code';
  if (/^gpt-\d/.test(id)) return 'codex';
  if (/^grok-\d/.test(id)) return 'grok';
  return '';
}

export function effectiveModelChoice(input: { provider?: unknown; model?: unknown; metadata?: unknown; agentChoice?: AgentModelChoice | null }): AgentModelChoice {
  const model = String(input.model ?? '').trim();
  const provider = String(input.provider ?? '').trim() || providerForModelId(model);
  if (provider && model && !SLOT_ALIASES.includes(model)) return { mode: 'pin', provider, model };
  return threadModelChoice(input.metadata, isAgentModelChoice(input.agentChoice) ? input.agentChoice : { mode: 'list' });
}
