// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Shared contract for model routing (Preferences → AI models). Approved design:
 * Projects/sulla-desktop/mockups/model-routing (Jonathon, 2026-11-02).
 * Main process owns the state; the renderer reads and writes it over IPC.
 */

export type ModelClass = 'frontier' | 'standard' | 'fast' | 'coding' | 'local';
export const MODEL_CLASSES: readonly ModelClass[] = ['frontier', 'standard', 'fast', 'coding', 'local'];

/** One row of the Agents or Subconscious list: a provider used at one class. */
export interface RoutingRow {
 provider: string; // provider id, e.g. 'claude-code', 'codex', 'anthropic', 'grok', 'ollama'
 class: ModelClass;
 enabled: boolean; // false = skipped without disconnecting
}

/** One model inside a class, in the order Sulla tries them. */
export interface ClassModel {
 provider: string;
 model: string; // provider's model id
}

export type ProviderStatus = 'ready' | 'cooling' | 'error' | 'skipped' | 'disconnected';

export interface RoutingProviderInfo {
 id: string;
 name: string;
 connected: boolean;
 local: boolean; // runs on this Mac (only local providers may use the Local class)
 subscription: boolean; // shares a usage limit across all uses (Claude Code, Codex ...)
 status: ProviderStatus;
 coolingUntil: string | null; // ISO time the usage limit resets
 lastError: string | null;
 models: { id: string; label: string }[];
}

/** The part of the routing state the human edits (and Reset restores). */
export interface EditableRoutingState {
 agentsList: RoutingRow[];
 subconsciousList: RoutingRow[];
 classes: Record<ModelClass, ClassModel[]>;
 followProviderOrder: Record<ModelClass, boolean>;
}

export interface ModelRoutingState extends EditableRoutingState {
 providers: RoutingProviderInfo[];
 /** What each Reset link restores. The UI disables a Reset link while its section already equals this. */
 recommended?: EditableRoutingState;
}

/** How an agent picks its model. Default is { mode: 'list' }. */
export type AgentModelChoice =
 | { mode: 'list' } // walk the Agents list (Subconscious list for subconscious agents)
 | { mode: 'class'; class: ModelClass } // walk that class's model list across providers
 | { mode: 'pin'; provider: string; model: string }; // one exact model, no fallback

/** IPC channel names (ipcRenderer.invoke / ipcMain.handle, and one push event). */
export const MODEL_ROUTING_IPC = {
 get: 'model-routing:get', // () => ModelRoutingState (with `recommended`)
 set: 'model-routing:set', // (patch: Partial<Pick<ModelRoutingState, 'agentsList'|'subconsciousList'|'classes'|'followProviderOrder'>>) => ModelRoutingState
 reset: 'model-routing:reset', // (target: { section: 'agents'|'subconscious'|'classes'; class?: ModelClass }) => ModelRoutingState
 status: 'model-routing:status', // main → renderer push: RoutingProviderInfo[] whenever a provider's status changes
} as const;
