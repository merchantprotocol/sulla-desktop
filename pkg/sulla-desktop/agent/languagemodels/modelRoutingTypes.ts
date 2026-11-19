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

/** A provider-neutral rule that picks a model from the provider's live list. */
export type ModelRule = { kind: 'first' } | { kind: 'contains'; text: string };

/** One model inside a class, in the order Sulla tries them. */
export interface ClassModel {
 provider: string;
 model: string; // provider's model id; for a rule, the model the rule picked at the last check
 rule?: ModelRule; // set when the model follows a rule instead of a fixed ID
 effort?: string; // reasoning effort sent with the run; unset = the provider's default for the model
 chosen?: boolean; // true once the human picked this entry (otherwise it came from Sulla's built-in defaults)
}

/** What changed in the providers' live model lists at the last Refresh models. */
export interface ModelCatalogReport {
 checks?: { provider: string; status: 'refreshed' | 'unavailable' }[];
 checkedAt: string | null;
 added: ClassModel[]; // models a provider lists now that it did not list at the previous check
 removed: ClassModel[]; // models a provider no longer lists
 moved: { class: ModelClass; provider: string; from: string; to: string }[]; // rule entries that now pick another model
}

export type ProviderStatus = 'ready' | 'cooling' | 'error' | 'skipped' | 'disconnected';

export interface RoutingProviderInfo {
 id: string;
 name: string;
 connected: boolean;
 accessMethod?: import('@pkg/shared/providerAccess').ProviderAccessMethod;
 accessLabel?: string;
 local: boolean; // runs on this Mac (only local providers may use the Local class)
 subscription: boolean; // shares a usage limit across all uses (Claude Code, Codex ...)
 status: ProviderStatus;
 coolingUntil: string | null; // ISO time the usage limit resets
 lastError: string | null;
 models: RoutingModelInfo[];
}

/**
 * A model and effort pair Sulla never runs, saved together. `effort` is one level, or 'any' to keep the
 * model out at every level. A role entry that would run a blocked pair is skipped, and rules never pick a
 * model blocked at 'any'.
 */
export interface NeverUsePair { provider: string; model: string; effort: string }

/** One model in a provider's list, with what the provider says about it. */
export interface RoutingModelInfo {
 id: string;
 label: string;
 efforts?: { id: string; description?: string }[]; // effort levels the model accepts
 defaultEffort?: string;
 upgrade?: string; // the model the provider recommends moving to
 unverified?: boolean; // from a fixed list, not reported by the provider
 selectionMode?: import('@pkg/shared/providerAccess').ModelSelectionMode;
}

/** The part of the routing state the human edits (and Reset restores). */
export interface EditableRoutingState {
 workerBindings?:     import('./workerModelBindings').WorkerModelBindings;
 agentsList: RoutingRow[];
 subconsciousList: RoutingRow[];
 classes: Record<ModelClass, ClassModel[]>;
 followProviderOrder: Record<ModelClass, boolean>;
 neverUse: NeverUsePair[]; // model and effort pairs Sulla never runs
}

export interface ModelRoutingState extends EditableRoutingState {
 workers?:     import('./workerModelBindings').WorkerModelInfo[];
 providers: RoutingProviderInfo[];
 /** What each Reset link restores. The UI disables a Reset link while its section already equals this. */
 recommended?: EditableRoutingState;
 /** The last Refresh models report. */
 catalog?: ModelCatalogReport;
 /** Agent names whose model choice is each class (built-in workers and custom agents). */
 classUsers?: Partial<Record<ModelClass, string[]>>;
}

/** How an agent picks its model. Default is { mode: 'list' }. */
export type AgentModelChoice =
 | { mode: 'list' } // walk the Agents list (Subconscious list for subconscious agents)
 | { mode: 'class'; class: ModelClass } // walk that class's model list across providers
 | { mode: 'pin'; provider: string; model: string; effort?: string }; // one exact model, no fallback

/** IPC channel names (ipcRenderer.invoke / ipcMain.handle, and one push event). */
export const MODEL_ROUTING_IPC = {
 cliCheck: 'model-routing:cli-check',
 cliUpdate: 'model-routing:cli-update',
 workerSet: 'model-routing:worker-set',
 get: 'model-routing:get', // () => ModelRoutingState (with `recommended`)
 set: 'model-routing:set', // (patch: Partial<Pick<ModelRoutingState, 'agentsList'|'subconsciousList'|'classes'|'followProviderOrder'|'neverUse'>>) => ModelRoutingState
  refresh:   'model-routing:refresh', // () => ModelRoutingState, after re-fetching every connected provider's model list
  reset: 'model-routing:reset', // (target: { section: 'agents'|'subconscious'|'classes'; class?: ModelClass }) => ModelRoutingState
  status: 'model-routing:status', // main → renderer push: RoutingProviderInfo[] whenever a provider's status changes
} as const;
