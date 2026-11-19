// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { PROVIDER_FACTORIES } from './index';
import { applyRules, compareCatalogs, effectiveEffort, isPairBlocked } from './modelCatalogRules';
import { LiveProviderSnapshot, type LiveProviderMap } from './LiveProviderSnapshot';
import { MODEL_CLASSES, type AgentModelChoice, type ClassModel, type EditableRoutingState, type ModelCatalogReport, type ModelClass, type RoutingModelInfo, type RoutingProviderInfo, type RoutingRow } from './modelRoutingTypes';
import { classifyLLMFailure, redactLLMFailureMessage } from './providerRecovery';
import { copyWorkerBindings } from './workerModelBindings';
import type { WorkerModelBinding } from './workerModelBindings';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { isSubscriptionAccess, type ProviderAccessMethod } from '@pkg/shared/providerAccess';

export interface ModelCandidate { provider: string; model: string; effort?: string }
export type EditableState = EditableRoutingState;
/**
 * Soft provider health. A provider is never removed from routing: failures only push it towards the back of
 * the line for a while. `failures` counts consecutive failed turns and resets on the first success.
 */
type Health = { status: 'cooling'|'error'; failures: number; until: number; lastError: string };

/** Consecutive failed turns a provider gets before it is backed off at all. */
export const BACKOFF_FREE_FAILURES = 2;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;
/** A provider-stated reset (quota / rate limit) is honoured, but we still re-probe at least this often. */
const PROVIDER_RESET_MAX_MS = 60 * 60_000;

/** How long a provider sits at the back of the line after `failures` consecutive failed turns. */
export function backoffMs(failures: number): number {
  if (failures <= BACKOFF_FREE_FAILURES) return 0;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - BACKOFF_FREE_FAILURES - 1));
}

const SETTING = 'modelRouting';
const HEALTH_SETTING = 'modelRoutingProviderHealth';
const CATALOG_SETTING = 'modelCatalogCheck';
const fallback: Partial<Record<ModelClass, ModelClass>> = { frontier: 'standard', coding: 'standard', fast: 'standard', standard: 'frontier' };
const localProviders = new Set(['ollama']);
const subscriptionProviders = new Set(['claude-code', 'codex']);
const providerOrder = Object.keys(PROVIDER_FACTORIES);

/** True for a provider id in the AI Infrastructure catalog (connected or not). */
export function isKnownProvider(id: string): boolean { return providerOrder.includes(id) }

// Deliberately static: defaults must not change underneath an installation when a
// provider changes its discovery endpoint. Unknown providers/models remain editable.
export const DEFAULT_MODELS: Partial<Record<string, Partial<Record<ModelClass, string[]>>>> = {
  'claude-code': { frontier: ['claude-opus-5-5'], standard: ['claude-sonnet-5-5'], fast: ['claude-haiku-5-5'], coding: ['claude-sonnet-5-5'] },
  codex: { frontier: ['gpt-5.5'], standard: ['gpt-5.6-terra'], fast: ['gpt-5.6-luna'], coding: ['gpt-5.6-sol'] },
  anthropic: { frontier: ['claude-opus-5-5'], standard: ['claude-sonnet-5-5'], fast: ['claude-haiku-5-5'], coding: ['claude-sonnet-5-5'] },
  openai: { frontier: ['gpt-5.5'], standard: ['gpt-5.3'], fast: ['gpt-5-mini'], coding: ['gpt-5.3-codex'] },
  grok: { frontier: ['grok-4.6'], standard: ['grok-4.1-fast'], fast: ['grok-4.1-fast'], coding: ['grok-code-fast-1'] },
  deepseek: { frontier: ['deepseek-v4-pro'], standard: ['deepseek-chat'], fast: ['deepseek-chat'], coding: ['deepseek-coder'] },
  google: { frontier: ['gemini-3-pro'], standard: ['gemini-3-flash'], fast: ['gemini-3-flash'], coding: ['gemini-3-pro'] },
  kimi: { frontier: ['kimi-k2.5'], standard: ['kimi-k2.5'], fast: ['kimi-k2.5'], coding: ['kimi-k2.5'] },
  alibaba: { frontier: ['qwen3-max'], standard: ['qwen3-plus'], fast: ['qwen3-turbo'], coding: ['qwen3-coder-plus'] },
  ollama: { local: ['llama3.1:8b'], fast: ['llama3.1:8b'], standard: ['llama3.1:8b'], coding: ['qwen2.5-coder:7b'] },
};

function strongest(provider: string): ModelClass {
  const table = DEFAULT_MODELS[provider] || {};
  return (['frontier', 'standard', 'fast', 'coding', 'local'] as ModelClass[]).find(c => table[c]?.length) || (localProviders.has(provider) ? 'local' : 'standard');
}

/** fast/coding/frontier → standard, standard → frontier, local → none; stops before repeating a class. */
export function classFallbackChain(cls: ModelClass): ModelClass[] {
  const chain: ModelClass[] = [cls];
  for (let next = fallback[cls]; next && !chain.includes(next); next = fallback[next]) chain.push(next);
  return chain;
}

/** The model list an agent asking for `cls` walks: the first non-empty class along its fallback chain. */
export function classWithFallback(classes: Record<ModelClass, ClassModel[]>, cls: ModelClass): ClassModel[] {
  for (const c of classFallbackChain(cls)) if (classes[c]?.length) return classes[c];
  return [];
}

function emptyClasses(): Record<ModelClass, ClassModel[]> {
  return { frontier: [], standard: [], fast: [], coding: [], local: [] };
}

export function recommendedState(connected = providerOrder): EditableState {
  const classes = emptyClasses();
  for (const provider of providerOrder) for (const cls of MODEL_CLASSES) {
    for (const model of DEFAULT_MODELS[provider]?.[cls] || []) classes[cls].push({ provider, model });
  }
  const onlineAlternative = connected.some(p => !subscriptionProviders.has(p));
  return {
    agentsList: connected.map(provider => ({ provider, class: strongest(provider), enabled: true })),
    subconsciousList: [...connected].sort((a, b) => Number(!localProviders.has(a)) - Number(!localProviders.has(b)) || Number(subscriptionProviders.has(a)) - Number(subscriptionProviders.has(b)) || providerOrder.indexOf(a) - providerOrder.indexOf(b)).map(provider => ({ provider, class: DEFAULT_MODELS[provider]?.fast?.length ? 'fast' : strongest(provider), enabled: !(onlineAlternative && subscriptionProviders.has(provider)) })),
    classes,
    followProviderOrder: { frontier: true, standard: true, fast: true, coding: true, local: true },
    neverUse: [],
  };
}

/**
 * Whether an existing same-agent mapping may be reused for a requested registration. An unmarked
 * (owner-saved or settled) mapping is authoritative; a marked one belongs to exactly one pending
 * publication and is never adopted for another, so a stale package pin cannot become owner settings.
 */
export function reusableForPublication(existing: WorkerModelBinding, requested?: { fileId: string; versionId: string }): boolean {
  const marker = existing.pendingPublication;
  return !marker || (!!requested && marker.fileId === requested.fileId && marker.versionId === requested.versionId);
}
export const STALE_PUBLICATION_MAPPING = 'An unsettled package model mapping from another publication exists; it was preserved for the owner to resolve in AI Models.';

export function canonicalProviderId(provider: string): string {
  const normalized = String(provider || '').trim().toLowerCase();
  const aliases: Record<string, string> = { 'claude code': 'claude-code', 'open ai': 'openai' };
  return aliases[normalized] || normalized.replace(/_/g, '-');
}

/** Settings saved before pairs: a blocked model meant "at any effort". Effort-only blocks have no model, so they are dropped. */
function legacyNeverUse(saved: any): EditableState['neverUse'] {
  return Array.isArray(saved?.blockedModels) ? saved.blockedModels.filter((b: any) => b?.provider && b?.model).map((b: any) => ({ provider: b.provider, model: b.model, effort: 'any' })) : [];
}

function normalize(saved: Partial<EditableState>, defaults: EditableState): EditableState {
  const classes = emptyClasses();
  for (const cls of MODEL_CLASSES) classes[cls] = Array.isArray(saved.classes?.[cls]) ? saved.classes![cls] : defaults.classes[cls];
  return {
    agentsList: Array.isArray(saved.agentsList) ? saved.agentsList : defaults.agentsList,
    subconsciousList: Array.isArray(saved.subconsciousList) ? saved.subconsciousList : defaults.subconsciousList,
    classes,
    followProviderOrder: { ...defaults.followProviderOrder, ...(saved.followProviderOrder || {}) },
    workerBindings:      copyWorkerBindings(saved.workerBindings),
    neverUse: Array.isArray(saved.neverUse) ? saved.neverUse : legacyNeverUse(saved),
  };
}

async function migrateLegacy(): Promise<EditableState> {
  const state = recommendedState();
  const primary = await SullaSettingsModel.get('primaryProvider', '');
  const primaryModel = await SullaSettingsModel.get('activeModelId', '');
  const secondary = await SullaSettingsModel.get('secondaryProvider', '');
  const secondaryModel = await SullaSettingsModel.get('secondaryModelId', '');
  const subconscious = await SullaSettingsModel.get('subconsciousProvider', '');
  const subconsciousModel = await SullaSettingsModel.get('subconsciousModelId', '');
  const seed = (provider: string, model: string, list: RoutingRow[]) => {
    if (!provider || provider === 'default') return;
    const cls = strongest(provider);
    list.unshift({ provider, class: cls, enabled: true });
    if (model && model !== provider && !state.classes[cls].some(x => x.provider === provider && x.model === model)) state.classes[cls].unshift({ provider, model });
  };
  state.agentsList = [];
  state.subconsciousList = [];
  seed(primary, primaryModel, state.agentsList);
  seed(secondary, secondaryModel, state.agentsList);
  seed(subconscious || primary, subconsciousModel, state.subconsciousList);
  if (!state.agentsList.length) state.agentsList = recommendedState().agentsList;
  if (!state.subconsciousList.length) state.subconsciousList = recommendedState().subconsciousList;
  await SullaSettingsModel.set(SETTING, state, 'json');
  return state;
}

export class ModelRouter {
  /** Optional provider-service source; tests inject one because ESM jest has no `require`. */
  constructor(private readonly providerService?: () => any) {}
  private health = new Map<string, Health>();
  private epochs = new Map<string, number>();
  private loadedHealth = false;
  private listeners = new Set<() => void>();
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly liveSnapshot = new LiveProviderSnapshot(() => this.loadLiveProviders());
  private providerListenerAttached = false;

  invalidateLiveProviders(): void { this.liveSnapshot.invalidate(); }

  onStatusChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit(): void { for (const listener of this.listeners) listener() }
  async getEditableState(): Promise<EditableState> {
    const saved = await SullaSettingsModel.get(SETTING, null);
    return saved && typeof saved === 'object' ? normalize(saved, recommendedState()) : migrateLegacy();
  }

  validatePatch(patch: Partial<EditableState>): void {
    const providers = new Set(providerOrder);
    const validateRows = (rows?: RoutingRow[]) => rows?.forEach(row => {
      if (!providers.has(row.provider)) throw new Error(`Unknown model provider: ${row.provider}`);
      if (!MODEL_CLASSES.includes(row.class)) throw new Error(`Unknown model class: ${row.class}`);
      if (row.class === 'local' && !localProviders.has(row.provider)) throw new Error(`Provider ${row.provider} cannot use the local class`);
    });
    validateRows(patch.agentsList); validateRows(patch.subconsciousList);
    if (patch.classes) for (const [cls, models] of Object.entries(patch.classes)) {
      if (!MODEL_CLASSES.includes(cls as ModelClass)) throw new Error(`Unknown model class: ${cls}`);
      for (const item of models || []) {
        if (!providers.has(item.provider)) throw new Error(`Unknown model provider: ${item.provider}`);
        if (cls === 'local' && !localProviders.has(item.provider)) throw new Error(`Provider ${item.provider} cannot use the local class`);
        if (item.rule && !(item.rule.kind === 'first' || (item.rule.kind === 'contains' && typeof item.rule.text === 'string' && item.rule.text.trim() && item.rule.text.length <= 60))) {
          throw new Error(`Invalid model rule for ${ item.provider }`);
        }
        if (item.effort !== undefined && !/^[a-z]{2,10}$/.test(item.effort)) throw new Error(`Invalid effort for ${ item.provider }`);
      }
    }
    for (const [slug, binding] of Object.entries(patch.workerBindings ?? {})) {
      if (!slug || !binding.agentId || !Number.isInteger(binding.revision) || binding.revision < 1 || !Array.isArray(binding.candidates) || !binding.candidates.length || binding.candidates.length > 10) throw new Error('Invalid worker model mapping');
      for (const candidate of binding.candidates) {
        if (!providers.has(candidate.provider) || !candidate.model?.trim() || (candidate.effort !== undefined && !/^[a-z]{2,10}$/.test(candidate.effort))) throw new Error('Invalid worker model candidate');
      }
    }
    for (const item of patch.neverUse || []) {
      if (!providers.has(item.provider) || !item.model || !(item.effort === 'any' || /^[a-z]{2,10}$/.test(item.effort || ''))) {
        throw new Error(`Invalid never-use pair: ${ item.provider }/${ item.model } at ${ item.effort }`);
      }
    }
  }

  private writes: Promise<unknown> = Promise.resolve();
  private serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation);
    this.writes = result.then(() => undefined, () => undefined);
    return result;
  }

  async set(patch: Partial<EditableState>): Promise<EditableState> {
    this.validatePatch(patch);
    return this.serializeWrite(async() => {
      const next = normalize({ ...(await this.getEditableState()), ...patch }, recommendedState());
      await SullaSettingsModel.set(SETTING, next, 'json');
      this.invalidateLiveProviders();
      return next;
    });
  }

  /** Atomically add an owner binding without replacing another mapping or a concurrent edit. */
  async addWorkerBindingIfAbsent(slug: string, binding: WorkerModelBinding): Promise<boolean> {
    this.validatePatch({ workerBindings: { [slug]: binding } });
    return this.serializeWrite(async() => {
      const current = await this.getEditableState();
      const existing = current.workerBindings?.[slug];
      if (existing) {
        if (existing.agentId !== binding.agentId) throw new Error('A different agent already owns this worker mapping; it was preserved.');
        // Enforced here too, inside the serialized write, for a marked mapping that raced the caller's pre-check.
        if (!reusableForPublication(existing, binding.pendingPublication)) throw new Error(STALE_PUBLICATION_MAPPING);
        return false;
      }
      const workerBindings = { ...(current.workerBindings ?? {}), [slug]: binding };
      const next = normalize({ ...current, workerBindings }, recommendedState());
      await SullaSettingsModel.set(SETTING, next, 'json');
      return true;
    });
  }

  /**
   * Owner edit of one worker mapping: compare-and-set against the opened token/revision inside the
   * write serializer, touching only this slug so concurrent registrations and rollbacks survive.
   */
  async replaceWorkerBinding(
    slug: string,
    agentId: string,
    /**
     * `entry` is the stored same-slug mapping (any agent) observed before the caller's async checks;
     * null when there was none. The write applies only if that exact entry is still stored.
     */
    expected: { token: string; revision: number; entry?: { agentId: string; editToken?: string; revision: number } | null },
    next: { editToken: string; connections: Record<string, string>; candidates: ModelCandidate[] } | null,
  ): Promise<EditableState> {
    if (next) this.validatePatch({ workerBindings: { [slug]: { agentId, revision: 1, candidates: next.candidates } } });
    return this.serializeWrite(async() => {
      const current = await this.getEditableState();
      const previous = current.workerBindings?.[slug];
      const own = previous?.agentId === agentId ? previous : undefined;
      const sameEntry = expected.entry === undefined || (expected.entry === null
        ? !previous
        : !!previous && previous.agentId === expected.entry.agentId && (previous.editToken ?? '') === (expected.entry.editToken ?? '') && previous.revision === expected.entry.revision);
      if (!sameEntry || (own?.editToken ?? '') !== expected.token || (own?.revision ?? 0) !== expected.revision) throw new Error('These model settings changed elsewhere. Reload the agent page before saving.');
      const workerBindings = { ...(current.workerBindings ?? {}) };
      if (next) workerBindings[slug] = { editToken: next.editToken, agentId, revision: (own?.revision ?? 0) + 1, connections: { ...next.connections }, candidates: next.candidates.map(row => ({ ...row })) };
      else delete workerBindings[slug];
      const state = normalize({ ...current, workerBindings }, recommendedState());
      await SullaSettingsModel.set(SETTING, state, 'json');
      return state;
    });
  }

  /**
   * Remove only a binding still owned by the exact definition that created it. With `created`,
   * remove only that exact entry: a later owner edit (new token/revision) is preserved.
   */
  async removeWorkerBindingIfOwned(slug: string, agentId: string, created?: { editToken: string; revision: number }): Promise<boolean> {
    return this.serializeWrite(async() => {
      const current = await this.getEditableState();
      const existing = current.workerBindings?.[slug];
      if (existing?.agentId !== agentId) return false;
      if (created && ((existing.editToken ?? '') !== created.editToken || existing.revision !== created.revision)) return false;
      const workerBindings = { ...current.workerBindings };
      delete workerBindings[slug];
      const next = normalize({ ...current, workerBindings }, recommendedState());
      await SullaSettingsModel.set(SETTING, next, 'json');
      return true;
    });
  }

  /** Drop the pending-publication marker from the exact entry it was written with; anything else is left alone. */
  async clearPendingPublication(slug: string, agentId: string, created: { editToken: string; revision: number }): Promise<boolean> {
    return this.serializeWrite(async() => {
      const current = await this.getEditableState();
      const existing = current.workerBindings?.[slug];
      if (!existing?.pendingPublication || existing.agentId !== agentId || (existing.editToken ?? '') !== created.editToken || existing.revision !== created.revision) return false;
      const { pendingPublication: _settled, ...settled } = existing;
      const next = normalize({ ...current, workerBindings: { ...current.workerBindings, [slug]: settled } }, recommendedState());
      await SullaSettingsModel.set(SETTING, next, 'json');
      return true;
    });
  }

  async reset(target: { section: 'agents'|'subconscious'|'classes'; class?: ModelClass }): Promise<EditableState> {
    const current = await this.getEditableState(); const defaults = recommendedState();
    if (target.section === 'agents') current.agentsList = defaults.agentsList;
    else if (target.section === 'subconscious') current.subconsciousList = defaults.subconsciousList;
    // A class reset restores the recommended models in provider order (the UI says so), so it turns
    // "Follow provider order" back on too.
    else if (target.class) {
      current.classes[target.class] = defaults.classes[target.class];
      current.followProviderOrder[target.class] = defaults.followProviderOrder[target.class];
    } else {
      current.classes = defaults.classes;
      current.followProviderOrder = defaults.followProviderOrder;
    }
    return this.set(target.section === 'agents'
      ? { agentsList: current.agentsList }
      : target.section === 'subconscious'
        ? { subconsciousList: current.subconsciousList }
        : { classes: current.classes, followProviderOrder: current.followProviderOrder });
  }

  // Health is in memory only. It is a routing hint, never a stored verdict: a restart starts every provider
  // fresh. The old build persisted hard lockouts under HEALTH_SETTING; wipe them once so they cannot strand us.
  private async loadHealth(): Promise<void> {
    if (this.loadedHealth) return;
    this.loadedHealth = true;
    try {
      const saved = await SullaSettingsModel.get(HEALTH_SETTING, {});
      if (!saved || typeof saved !== 'object' || Object.keys(saved).length) await SullaSettingsModel.set(HEALTH_SETTING, {}, 'json');
    } catch { /* best effort */ }
  }
  /** Is this provider currently backed off? Expired entries keep their failure count so the next failure backs off longer. */
  private backedOff(provider: string, now = Date.now()): boolean { const h = this.health.get(canonicalProviderId(provider)); return !!h && h.until > now }
  private expire(): void {
    const now = Date.now(); let next = Infinity;
    for (const h of this.health.values()) if (h.until > now) next = Math.min(next, h.until);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (Number.isFinite(next)) { this.expiryTimer = setTimeout(() => { this.expiryTimer = null; this.emit(); this.expire() }, Math.max(0, next - now)); this.expiryTimer.unref?.() }
  }
  /** Record one failed turn for a provider (after its own retries). Repeated failures back it off longer. */
  attemptToken(provider: string): number { return this.epochs.get(canonicalProviderId(provider)) || 0 }
  async markFailure(provider: string, error: unknown, headers?: Record<string, string>, attemptEpoch?: number): Promise<void> {
    await this.loadHealth(); provider = canonicalProviderId(provider); const failure = classifyLLMFailure(error); const text = redactLLMFailureMessage(error);
    if (failure.kind === 'interrupted' || failure.kind === 'infrastructure') return;
    if (attemptEpoch !== undefined && attemptEpoch !== (this.epochs.get(provider) || 0)) return;
    const usage = failure.kind === 'quota' || failure.kind === 'rate_limit';
    const failures = (this.health.get(provider)?.failures || 0) + 1;
    const now = Date.now();
    let until = now + backoffMs(failures);
    if (usage) {
      const errorHeaders = (error as any)?.headers || (error as any)?.response?.headers || {};
      const readHeader = (name: string) => headers?.[name] || errorHeaders?.[name] || errorHeaders?.get?.(name);
      const header = readHeader('retry-after') || readHeader('x-ratelimit-reset') || readHeader('ratelimit-reset');
      const messageTime = text.match(/(?:reset|retry(?: after)?)[^\d]*(\d{10,13})/i)?.[1];
      let reset = NaN;
      if (header) reset = /^\d+$/.test(header) ? (Number(header) > 1e9 ? Number(header) * (Number(header) < 1e12 ? 1000 : 1) : now + Number(header) * 1000) : Date.parse(header);
      else if (messageTime) reset = Number(messageTime) * (Number(messageTime) < 1e12 ? 1000 : 1);
      if (Number.isFinite(reset) && reset > now) until = Math.max(until, Math.min(reset, now + PROVIDER_RESET_MAX_MS));
    }
    this.health.set(provider, { status: usage ? 'cooling' : 'error', failures, until, lastError: text });
    this.expire(); this.emit();
  }
  /** A successful turn puts the provider straight back in its normal place. */
  async markSuccess(provider: string): Promise<void> {
    await this.loadHealth(); provider = canonicalProviderId(provider);
    this.epochs.set(provider, (this.epochs.get(provider) || 0) + 1);
    if (this.health.delete(provider)) { this.expire(); this.emit() }
  }
  async clear(provider: string): Promise<void> { await this.loadHealth(); provider = canonicalProviderId(provider); if (this.health.delete(provider)) { this.expire(); this.emit() } }
  /** True while the provider is backed off. Backed-off providers are still routed, just after the healthy ones. */
  async isUnavailable(provider: string): Promise<boolean> { await this.loadHealth(); return this.backedOff(provider) }

  private liveProviders(): Promise<LiveProviderMap> {
    return this.liveSnapshot.get();
  }

  private async loadLiveProviders(): Promise<LiveProviderMap> {
    const mps = (() => { try { return this.providerService ? this.providerService() : require('../services/ModelProviderService').getModelProviderService() } catch { return null } })();
    if (!this.providerListenerAttached && mps?.onChange) {
      this.providerListenerAttached = true;
      mps.onChange(() => this.invalidateLiveProviders());
    }
    let available = new Map<string, { connected: boolean; connectionUnknown: boolean; accessMethod?: ProviderAccessMethod; accessLabel?: string }>();
    try {
      available = new Map((await mps?.getAvailableProviders?.() || []).map((provider: any) => [String(provider.id), {
        connected: provider.connected === true && provider.selectable !== false && provider.accessMethod !== 'unknown',
        // Only a real lookup fault is "unknown" (still tried with authenticated
        // execution). An unconfigured or disconnected selected account also
        // reports accessMethod 'unknown' but is known unrunnable.
        connectionUnknown: provider.connectionStatus === 'unknown',
        accessMethod: provider.accessMethod as ProviderAccessMethod | undefined,
        accessLabel: typeof provider.accessLabel === 'string' ? provider.accessLabel : undefined,
      }]))
    } catch { /* fail closed */ }
    const entries = await Promise.all(providerOrder.map(async id => {
      const connected = available.get(id)?.connected === true;
      const connectionUnknown = available.get(id)?.connectionUnknown === true;
      let models: RoutingModelInfo[] = [];
      if (connected && mps?.getModelsForProvider) {
        try {
          models = (await mps.getModelsForProvider(id, { liveOnly: true })).map((model: any) => ({
            id:    String(model.id),
            label: String(model.name || model.label || model.id),
            ...(Array.isArray(model.efforts) && model.efforts.length ? { efforts: model.efforts } : {}),
            ...(model.defaultEffort ? { defaultEffort: String(model.defaultEffort) } : {}),
            ...(model.upgrade ? { upgrade: String(model.upgrade) } : {}),
            ...(model.unverified ? { unverified: true } : {}),
            ...(model.selectionMode ? { selectionMode: model.selectionMode } : {}),
          }));
        } catch { /* discovery is best effort */ }
      }
      return [id, { connected, connectionUnknown, accessMethod: available.get(id)?.accessMethod, accessLabel: available.get(id)?.accessLabel, models }] as const;
    }));
    return new Map(entries);
  }

  /** Snapshot soft health once at launch; a resumed selection never jumps backwards. */
  async workerLaunchCandidates(candidates: ModelCandidate[]): Promise<ModelCandidate[]> {
    await this.loadHealth();
    return [...candidates.filter(row => !this.backedOff(row.provider)), ...candidates.filter(row => this.backedOff(row.provider))];
  }

  async resolve(target: 'agents'|'subconscious', choice: AgentModelChoice = { mode: 'list' }): Promise<ModelCandidate[]> {
    const state = await this.getEditableState();
    const live = await this.liveProviders();
    const pinned = choice.mode === 'pin'
      ? { provider: canonicalProviderId(choice.provider), model: choice.model, ...(choice.effort !== undefined ? { effort: choice.effort } : {}) }
      : null;
    // A human's explicit selector choice is a hard route boundary. Recovery may retry this
    // exact route, but it must never substitute a configured alternate provider or model.
    if (pinned) {
      if (pinned.effort !== undefined) {
        const levels = live.get(pinned.provider)?.models.find(model => model.id === pinned.model)?.efforts;
        if (pinned.provider !== 'codex' || !levels?.some(level => level.id === pinned.effort)) {
          throw new Error(`Requested effort "${ pinned.effort }" is not advertised for ${ pinned.provider }/${ pinned.model }. Refresh models and choose a supported effort, or omit effort for the default.`);
        }
      }
      return [pinned];
    }
    // Rules pick from the live lists; never-use models are skipped everywhere except an explicit pin above.
    const liveModels = new Map([...live].map(([id, p]) => [id, p.models] as const));
    state.classes = applyRules(state.classes, liveModels, state.neverUse).classes;
    // A list row uses its provider's first model in the row's own class. If that class has no model for the
    // provider the row is skipped: it never silently changes class. Only an agent that asks for a class
    // directly walks the class fallback chain (approved mockup, Projects/sulla-desktop/mockups/model-routing).
    const source = choice.mode === 'class'
      ? classWithFallback(state.classes, choice.class)
      : (target === 'subconscious' ? state.subconsciousList : state.agentsList).filter(row => row.enabled).flatMap(row => state.classes[row.class].filter(item => item.provider === row.provider).slice(0, 1));
    // Every connected provider stays in the result. Backed-off providers keep their relative order but move
    // behind the healthy ones, so they are still tried as a last resort instead of producing "no provider".
    await this.loadHealth();
    const now = Date.now(); const healthy: ModelCandidate[] = []; const backedOff: ModelCandidate[] = [];
    for (let item of source) {
      const provider = live.get(item.provider);
      // Discovery is advisory; unknown status still enters authenticated execution.
      if (!provider?.connected && !provider?.connectionUnknown) continue;
      // A never-use pair is skipped whole: that model is never run at that effort.
      if (isPairBlocked(state.neverUse, item.provider, item.model, effectiveEffort(item, provider?.models ?? []))) continue;
      item = { provider: item.provider, model: item.model, ...(item.effort ? { effort: item.effort } : {}) };
      if ([...healthy, ...backedOff].some(x => x.provider === item.provider && x.model === item.model)) continue;
      (this.backedOff(item.provider, now) ? backedOff : healthy).push(item);
    }
    // If every connected candidate is backed off, health has stopped being useful. Reset it so the next
    // message starts from the configured top rather than preserving a de-facto lockout.
    if (!healthy.length && backedOff.length) {
      this.health.clear();
      this.expire();
      this.emit();
      return backedOff;
    }
    const configured = [...healthy, ...backedOff];
    return configured;
  }

  /**
   * Refresh models: re-fetch every connected provider's list past its cache, re-resolve rules,
   * and record what changed since the previous check.
   */
  async refreshCatalog(): Promise<ModelCatalogReport> {
    await Promise.allSettled([
      import('./claudeModelCatalog').then(m => m.clearClaudeModelCatalogCache()),
      import('./codexModelCatalog').then(m => m.clearCodexModelCatalogCache()),
      import('./cursorModelCatalog').then(m => m.clearCursorModelCatalogCache()),
      import('./openCodeModelCatalog').then(m => m.clearOpenCodeModelCatalogCache()),
      import('../services/brokeredModelList').then(m => m.clearBrokeredModelListCache()),
      import('./ModelDiscoveryService').then(m => m.modelDiscoveryService.clearCache()),
    ]);
    this.invalidateLiveProviders();
    const live = await this.liveProviders();
    const lists: Record<string, string[]> = {};
    const checks: NonNullable<ModelCatalogReport['checks']> = [];
    for (const [id, p] of live) {
      if (!p.connected) continue;
      const reported = p.models.filter(model => !model.unverified && !['claude-code', 'codex', 'cursor', 'opencode'].includes(model.id));
      checks.push({ provider: id, status: reported.length ? 'refreshed' : 'unavailable' });
      if (reported.length) lists[id] = p.models.map(m => m.id);
    }
    const saved = await SullaSettingsModel.get(CATALOG_SETTING, null) as { lists?: Record<string, string[]> } | null;
    const { added, removed } = compareCatalogs(saved?.lists || {}, lists);
    const state = await this.getEditableState();
    const { classes, moved } = applyRules(state.classes, new Map([...live].filter(([id]) => !!lists[id]).map(([id, p]) => [id, p.models] as const)), state.neverUse);
    if (moved.length) await this.set({ classes });
    const report: ModelCatalogReport = { checkedAt: new Date().toISOString(), added, removed, moved, checks };
    await SullaSettingsModel.set(CATALOG_SETTING, { lists: { ...(saved?.lists || {}), ...lists }, report }, 'json');
    return report;
  }

  async catalogReport(): Promise<ModelCatalogReport> {
    const saved = await SullaSettingsModel.get(CATALOG_SETTING, null) as { report?: ModelCatalogReport } | null;
    return saved?.report || { checkedAt: null, added: [], removed: [], moved: [] };
  }

  async providerInfo(): Promise<RoutingProviderInfo[]> {
    await this.loadHealth();
    const live = await this.liveProviders(); const now = Date.now();
    return providerOrder.map(id => {
      const h = this.backedOff(id, now) ? this.health.get(id) : undefined;
      const current = live.get(id);
      const connected = current?.connected === true;
      const accessMethod = current?.accessMethod;
      return {
        id,
        name: id,
        connected,
        ...(accessMethod ? { accessMethod } : {}),
        ...(current?.accessLabel ? { accessLabel: current.accessLabel } : {}),
        local: localProviders.has(id),
        subscription: accessMethod ? isSubscriptionAccess(accessMethod) : subscriptionProviders.has(id),
        status: current?.connectionUnknown ? 'error' : !connected ? 'disconnected' : h?.status || 'ready',
        coolingUntil: h?.status === 'cooling' ? new Date(h.until).toISOString() : null,
        lastError: current?.connectionUnknown ? 'Connection status is temporarily unavailable; authentication is checked when starting a model.' : h?.lastError || null,
        models: current?.models.length ? current.models : [],
      };
    });
  }
}

export const modelRouter = new ModelRouter();
