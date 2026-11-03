// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Preferences → AI models → Defaults: who answers a new chat when no agent is picked, and who runs the
 * heartbeat. Approved mockup: Projects/sulla-desktop/mockups/model-routing (Jonathon, 2026-11-02).
 */

import type { AgentModelChoice } from './modelRoutingTypes';

/** `agent`: that agent runs with its own Model setting. `model`: Sulla runs on `choice` (no agent change). */
export type ModelDefaultChoice =
 | { kind: 'agent'; agentId: string }
 | { kind: 'model'; choice: AgentModelChoice };

export interface ModelDefaults {
 chat: ModelDefaultChoice;
 heartbeat: ModelDefaultChoice;
}

export type ModelDefaultKey = keyof ModelDefaults;
export const MODEL_DEFAULT_KEYS: readonly ModelDefaultKey[] = ['chat', 'heartbeat'];

/** One option in the Defaults agent dropdown: enabled agents only, Sulla first. */
export interface DefaultAgentOption {
 slug: string;
 name: string;
 whenToCall: string;
 /** The agent's own Model setting, so the card can show what it resolves to. */
 modelChoice: AgentModelChoice;
}

export interface ModelDefaultsState {
 defaults: ModelDefaults;
 /** What Reset to default restores. */
 recommended: ModelDefaults;
 agents: DefaultAgentOption[];
}

export const MODEL_DEFAULTS_IPC = {
 get: 'model-defaults:get', // () => ModelDefaultsState
 set: 'model-defaults:set', // (patch: Partial<ModelDefaults>) => ModelDefaultsState
 reset: 'model-defaults:reset', // () => ModelDefaultsState
} as const;

export function sameModelChoice(a: AgentModelChoice, b: AgentModelChoice): boolean {
 if (a.mode !== b.mode) return false;
 if (a.mode === 'class' && b.mode === 'class') return a.class === b.class;
 if (a.mode === 'pin' && b.mode === 'pin') return a.provider === b.provider && a.model === b.model;
 return true;
}

export function sameModelDefault(a: ModelDefaultChoice, b: ModelDefaultChoice): boolean {
 if (a.kind === 'agent' && b.kind === 'agent') return a.agentId === b.agentId;
 if (a.kind === 'model' && b.kind === 'model') return sameModelChoice(a.choice, b.choice);
 return false;
}

/** True when both rows already equal the recommended defaults (Reset to default is disabled then). */
export function sameModelDefaults(a: ModelDefaults, b: ModelDefaults): boolean {
 return MODEL_DEFAULT_KEYS.every(key => sameModelDefault(a[key], b[key]));
}
