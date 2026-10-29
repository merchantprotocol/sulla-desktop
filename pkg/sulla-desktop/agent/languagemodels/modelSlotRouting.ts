// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Which configured model slot a graph run should chat through.
 *
 * Work-executing agents (workflow-node agents, spawned worker agents) must run on the PRIMARY model
 * chain so autonomous work quality matches interactive chat on every install,
 * regardless of local configuration (Jonathon directive 2026-09-01). The
 * subconscious slot is reserved for observation/recall/summarizer agents.
 *
 * Resolution order:
 *   1. `metadata.modelSlot` — explicit graph-stamped slot, always wins.
 *   2. Legacy heuristic — `isSubAgent` alone implies subconscious. Kept so
 *      unmarked observer graphs keep their fast tool-emitting chat peer.
 */

export type ModelSlot = 'primary' | 'subconscious';

export function resolveModelSlot(metadata: Record<string, unknown> | null | undefined): ModelSlot {
  const explicit = (metadata as any)?.modelSlot;
  if (explicit === 'primary' || explicit === 'subconscious') return explicit;

  return (metadata as any)?.isSubAgent ? 'subconscious' : 'primary';
}

const MODEL_ROUTING_ALIASES = new Set(['primary', 'secondary', 'subconscious', 'fast', 'balanced', 'powerful']);

/**
 * Slot names ('primary', 'subconscious', …) and tier names ('fast', …) are
 * what agent definitions store in place of a model id. They resolve to a real
 * model at run time, so they must never be pinned as a provider model id.
 */
export function isModelRoutingAlias(model: string | null | undefined): boolean {
  return !!model && MODEL_ROUTING_ALIASES.has(model.trim().toLowerCase());
}
