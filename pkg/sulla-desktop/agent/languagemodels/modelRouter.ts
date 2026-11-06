// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { classifyLLMFailure, redactLLMFailureMessage } from './providerRecovery';
import { MODEL_CLASSES, type AgentModelChoice, type ClassModel, type EditableRoutingState, type ModelClass, type RoutingProviderInfo, type RoutingRow } from './modelRoutingTypes';
import { PROVIDER_FACTORIES } from './index';

export type ModelCandidate = { provider: string; model: string };
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
  codex: { frontier: ['gpt-5.5'], standard: ['gpt-5.3-codex'], fast: ['gpt-5.1-codex-mini'], coding: ['gpt-5.3-codex'] },
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
  };
}

export function canonicalProviderId(provider: string): string {
  const normalized = String(provider || '').trim().toLowerCase();
  const aliases: Record<string, string> = { 'claude code': 'claude-code', 'open ai': 'openai' };
  return aliases[normalized] || normalized.replace(/_/g, '-');
}

function normalize(saved: Partial<EditableState>, defaults: EditableState): EditableState {
  const classes = emptyClasses();
  for (const cls of MODEL_CLASSES) classes[cls] = Array.isArray(saved.classes?.[cls]) ? saved.classes![cls] : defaults.classes[cls];
  return {
    agentsList: Array.isArray(saved.agentsList) ? saved.agentsList : defaults.agentsList,
    subconsciousList: Array.isArray(saved.subconsciousList) ? saved.subconsciousList : defaults.subconsciousList,
    classes,
    followProviderOrder: { ...defaults.followProviderOrder, ...(saved.followProviderOrder || {}) },
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
      }
    }
  }

  async set(patch: Partial<EditableState>): Promise<EditableState> {
    this.validatePatch(patch);
    const next = normalize({ ...(await this.getEditableState()), ...patch }, recommendedState());
    await SullaSettingsModel.set(SETTING, next, 'json');
    return next;
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
    return this.set(current);
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

  private async liveProviders(): Promise<Map<string, { connected: boolean; models: { id: string; label: string }[] }>> {
    const mps = (() => { try { return this.providerService ? this.providerService() : require('../services/ModelProviderService').getModelProviderService() } catch { return null } })();
    let available = new Map<string, boolean>();
    try { available = new Map((await mps?.getAvailableProviders?.() || []).map((provider: any) => [String(provider.id), provider.connected === true])) } catch { /* fail closed */ }
    const entries = await Promise.all(providerOrder.map(async id => {
      const connected = available.get(id) === true;
      let models: { id: string; label: string }[] = [];
      if (connected && mps?.getModelsForProvider) {
        try { models = (await mps.getModelsForProvider(id)).map((model: any) => ({ id: String(model.id), label: String(model.name || model.label || model.id) })) } catch { /* discovery is best effort */ }
      }
      return [id, { connected, models }] as const;
    }));
    return new Map(entries);
  }

  async resolve(target: 'agents'|'subconscious', choice: AgentModelChoice = { mode: 'list' }): Promise<ModelCandidate[]> {
    const state = await this.getEditableState();
    const live = await this.liveProviders();
    const pinned = choice.mode === 'pin'
      ? { provider: canonicalProviderId(choice.provider), model: choice.model }
      : null;
    // A human's explicit selector choice is a hard route boundary. Recovery may retry this
    // exact route, but it must never substitute a configured alternate provider or model.
    if (pinned) return [pinned];
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
    for (const item of source) {
      if (!live.get(item.provider)?.connected) continue;
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

  async providerInfo(): Promise<RoutingProviderInfo[]> {
    await this.loadHealth();
    const live = await this.liveProviders(); const now = Date.now();
    return providerOrder.map(id => { const h = this.backedOff(id, now) ? this.health.get(id) : undefined; const current = live.get(id); const connected = current?.connected === true; return { id, name: id, connected, local: localProviders.has(id), subscription: subscriptionProviders.has(id), status: !connected ? 'disconnected' : h?.status || 'ready', coolingUntil: h?.status === 'cooling' ? new Date(h.until).toISOString() : null, lastError: h?.lastError || null, models: current?.models.length ? current.models : [] } });
  }
}

export const modelRouter = new ModelRouter();
