// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { classifyLLMFailure, redactLLMFailureMessage } from './providerRecovery';
import { MODEL_CLASSES, type AgentModelChoice, type ClassModel, type ModelClass, type ModelRoutingState, type RoutingProviderInfo, type RoutingRow } from './modelRoutingTypes';
import { PROVIDER_FACTORIES } from './index';

export type ModelCandidate = { provider: string; model: string };
type EditableState = Pick<ModelRoutingState, 'agentsList'|'subconsciousList'|'classes'|'followProviderOrder'>;
type Health = { status: 'cooling'|'error'; until: number; lastError: string };

const SETTING = 'modelRouting';
const HEALTH_SETTING = 'modelRoutingProviderHealth';
const fallback: Partial<Record<ModelClass, ModelClass>> = { frontier: 'standard', coding: 'standard', fast: 'standard', standard: 'frontier' };
const localProviders = new Set(['ollama']);
const subscriptionProviders = new Set(['claude-code', 'codex']);
const providerOrder = Object.keys(PROVIDER_FACTORIES);

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
  private health = new Map<string, Health>();
  private loadedHealth = false;
  private listeners = new Set<() => void>();
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  onStatusChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit(): void { for (const listener of this.listeners) listener() }
  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const next = Math.min(...[...this.health.values()].map(item => item.until));
    if (!Number.isFinite(next)) { this.expiryTimer = null; return }
    this.expiryTimer = setTimeout(() => { this.expiryTimer = null; this.expire() }, Math.max(0, next - Date.now()));
    this.expiryTimer.unref?.();
  }

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
    else if (target.class) current.classes[target.class] = defaults.classes[target.class];
    else current.classes = defaults.classes;
    return this.set(current);
  }

  private async loadHealth(): Promise<void> {
    if (this.loadedHealth) return;
    const saved = await SullaSettingsModel.get(HEALTH_SETTING, {});
    for (const [provider, value] of Object.entries(saved || {})) this.health.set(provider, value as Health);
    this.loadedHealth = true; this.expire(); this.scheduleExpiry();
  }
  private expire(): void {
    const now = Date.now(); let changed = false;
    for (const [provider, h] of this.health) if (h.until <= now) { this.health.delete(provider); changed = true }
    if (changed) { void this.persistHealth(); this.emit() }
    this.scheduleExpiry();
  }
  private async persistHealth(): Promise<void> { await SullaSettingsModel.set(HEALTH_SETTING, Object.fromEntries(this.health), 'json') }
  async markFailure(provider: string, error: unknown, headers?: Record<string, string>): Promise<void> {
    await this.loadHealth(); const failure = classifyLLMFailure(error); const text = redactLLMFailureMessage(error);
    const usage = failure.kind === 'quota' || failure.kind === 'rate_limit';
    const errorHeaders = (error as any)?.headers || (error as any)?.response?.headers || {};
    const readHeader = (name: string) => headers?.[name] || errorHeaders?.[name] || errorHeaders?.get?.(name);
    const header = readHeader('retry-after') || readHeader('x-ratelimit-reset') || readHeader('ratelimit-reset');
    const messageTime = text.match(/(?:reset|retry(?: after)?)[^\d]*(\d{10,13})/i)?.[1];
    let until = Date.now() + 15 * 60_000;
    if (header) until = /^\d+$/.test(header) ? (Number(header) > 1e9 ? Number(header) * (Number(header) < 1e12 ? 1000 : 1) : Date.now() + Number(header) * 1000) : Date.parse(header);
    else if (messageTime) until = Number(messageTime) * (Number(messageTime) < 1e12 ? 1000 : 1);
    this.health.set(provider, { status: usage ? 'cooling' : 'error', until: Number.isFinite(until) ? until : Date.now() + 15 * 60_000, lastError: text });
    await this.persistHealth(); this.scheduleExpiry(); this.emit();
  }
  async clear(provider: string): Promise<void> { await this.loadHealth(); if (this.health.delete(provider)) { await this.persistHealth(); this.scheduleExpiry(); this.emit() } }
  async isUnavailable(provider: string): Promise<boolean> { await this.loadHealth(); this.expire(); return this.health.has(provider) }

  private async liveProviders(): Promise<Map<string, { connected: boolean; models: { id: string; label: string }[] }>> {
    const mps = (() => { try { return require('../services/ModelProviderService').getModelProviderService() } catch { return null } })();
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
    if (choice.mode === 'pin') return live.get(choice.provider)?.connected ? [{ provider: choice.provider, model: choice.model }] : [];
    const pickClass = (cls: ModelClass): ClassModel[] => state.classes[cls].length ? state.classes[cls] : (fallback[cls] ? state.classes[fallback[cls]!] : []);
    const source = choice.mode === 'class' ? pickClass(choice.class) : (target === 'subconscious' ? state.subconsciousList : state.agentsList).filter(row => row.enabled).flatMap(row => pickClass(row.class).filter(item => item.provider === row.provider).slice(0, 1));
    const result: ModelCandidate[] = [];
    for (const item of source) if (live.get(item.provider)?.connected && !await this.isUnavailable(item.provider) && !result.some(x => x.provider === item.provider && x.model === item.model)) result.push(item);
    return result;
  }

  async providerInfo(): Promise<RoutingProviderInfo[]> {
    await this.loadHealth(); this.expire();
    const live = await this.liveProviders();
    return providerOrder.map(id => { const h = this.health.get(id); const current = live.get(id); const connected = current?.connected === true; return { id, name: id, connected, local: localProviders.has(id), subscription: subscriptionProviders.has(id), status: !connected ? 'disconnected' : h?.status || 'ready', coolingUntil: h?.status === 'cooling' ? new Date(h.until).toISOString() : null, lastError: h?.lastError || null, models: current?.models.length ? current.models : [] } });
  }
}

export const modelRouter = new ModelRouter();
