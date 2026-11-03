// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Pure logic behind Preferences → AI models (approved mockup:
 * Projects/sulla-desktop/mockups/model-routing). No DOM, no IPC: the
 * components render what these functions compute, so every chip, summary
 * and trace on the page comes from one source.
 */

import {
  MODEL_CLASSES, type AgentModelChoice, type ClassModel, type ModelClass, type ModelRoutingState, type RoutingProviderInfo, type RoutingRow,
} from '@pkg/agent/languagemodels/modelRoutingTypes';

export type RoutingListKey = 'agents' | 'subconscious';

export const CLASS_LABELS: Record<ModelClass, string> = { frontier: 'Frontier', standard: 'Standard', fast: 'Fast', coding: 'Coding', local: 'Local' };
export const CLASS_DESCRIPTIONS: Record<ModelClass, string> = {
  frontier: 'Hardest reasoning, planning, reviews',
  standard: 'Everyday chat and most workers',
  fast:     'Cheap, light, background work',
  coding:   'Code-writing workers',
  local:    'Stays on this Mac',
};
/** Where an agent that asks for an empty class goes instead. Local never leaves the Mac. */
export const CLASS_FALLBACK: Partial<Record<ModelClass, ModelClass>> = { frontier: 'standard', coding: 'standard', fast: 'standard', standard: 'frontier' };

// ── Provider and model display ────────────────────────────────────────────

interface ProviderMeta { name: string; letter: string; kind: string }

/** Display names for the AI Infrastructure catalog (the backend sends ids as names). */
const PROVIDER_META: Record<string, ProviderMeta> = {
  'claude-code':      { name: 'Claude Code', letter: 'C', kind: 'Claude subscription · command line' },
  codex:              { name: 'OpenAI Codex', letter: 'X', kind: 'ChatGPT subscription · command line' },
  anthropic:          { name: 'Anthropic', letter: 'A', kind: 'API key' },
  openai:             { name: 'OpenAI', letter: 'O', kind: 'API key' },
  google:             { name: 'Google Gemini', letter: 'G', kind: 'API key' },
  grok:               { name: 'Grok', letter: 'K', kind: 'API key' },
  deepseek:           { name: 'DeepSeek', letter: 'D', kind: 'API key' },
  kimi:               { name: 'Kimi', letter: 'K', kind: 'API key' },
  alibaba:            { name: 'Alibaba Cloud', letter: 'Q', kind: 'API key' },
  nvidia:             { name: 'NVIDIA', letter: 'N', kind: 'API key' },
  arcee:              { name: 'Arcee AI', letter: 'R', kind: 'API key' },
  cerebras:           { name: 'Cerebras', letter: 'C', kind: 'API key' },
  together:           { name: 'Together AI', letter: 'T', kind: 'API key' },
  'vertex-ai':        { name: 'Google Vertex AI Express', letter: 'V', kind: 'API key' },
  opencode:           { name: 'OpenCode', letter: 'O', kind: 'Command line' },
  cursor:             { name: 'Cursor CLI', letter: 'U', kind: 'Command line' },
  enterprise_gateway: { name: 'Merchant Protocol Enterprise Gateway', letter: 'M', kind: 'Gateway' },
  custom:             { name: 'OpenAI-compatible endpoint', letter: '·', kind: 'Custom URL' },
  ollama:             { name: 'Ollama', letter: 'L', kind: 'On this Mac' },
};

const MODEL_NAMES: Record<string, string> = {
  'claude-opus-5-5': 'Claude Opus 5.5', 'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-haiku-5-5': 'Claude Haiku 5.5',
  'claude-opus-5': 'Claude Opus 5', 'claude-sonnet-5': 'Claude Sonnet 5',
  'gpt-5.5': 'GPT-5.5', 'gpt-5.5-pro': 'GPT-5.5 Pro', 'gpt-5.4': 'GPT-5.4', 'gpt-5.3': 'GPT-5.3', 'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5.1-codex-mini': 'GPT-5.1 Codex mini', 'gpt-5-mini': 'GPT-5 mini', 'gpt-5.6-luna': 'GPT-5.6 Luna', 'gpt-5.6-sol': 'GPT-5.6 Sol',
  'grok-4.6': 'Grok 4.6', 'grok-4.5': 'Grok 4.5', 'grok-4.1-fast': 'Grok 4.1 Fast', 'grok-code-fast-1': 'Grok Code Fast 1', 'grok-composer-2.5-fast': 'Grok Composer 2.5 Fast',
  'deepseek-v4-pro': 'DeepSeek V4 Pro', 'deepseek-v4-flash': 'DeepSeek V4 Flash', 'deepseek-chat': 'DeepSeek Chat', 'deepseek-coder': 'DeepSeek Coder', 'deepseek-reasoner': 'DeepSeek Reasoner',
  'gemini-3-pro': 'Gemini 3 Pro', 'gemini-3-flash': 'Gemini 3 Flash', 'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'kimi-k2.5': 'Kimi K2.5', 'qwen3-max': 'Qwen3 Max', 'qwen3-plus': 'Qwen3 Plus', 'qwen3-turbo': 'Qwen3 Turbo', 'qwen3-coder-plus': 'Qwen3 Coder Plus',
};

export function findProvider(state: Pick<ModelRoutingState, 'providers'>, id: string): RoutingProviderInfo | undefined {
  return state.providers.find(p => p.id === id);
}

export function providerName(state: Pick<ModelRoutingState, 'providers'> | null | undefined, id: string): string {
  const info = state ? findProvider(state, id) : undefined;
  if (info?.name && info.name !== id) return info.name;
  return PROVIDER_META[id]?.name ?? info?.name ?? id;
}

export function providerLetter(state: Pick<ModelRoutingState, 'providers'>, id: string): string {
  return PROVIDER_META[id]?.letter ?? (providerName(state, id).match(/[A-Za-z0-9]/)?.[0] ?? '·').toUpperCase();
}

export function providerKind(state: Pick<ModelRoutingState, 'providers'>, id: string): string {
  const info = findProvider(state, id);
  if (PROVIDER_META[id]) return PROVIDER_META[id].kind;
  if (info?.local) return 'On this Mac';
  return info?.subscription ? 'Subscription · command line' : 'API key';
}

export function modelName(state: Pick<ModelRoutingState, 'providers'>, provider: string, model: string): string {
  const label = findProvider(state, provider)?.models.find(m => m.id === model)?.label;
  if (label && label !== model) return label;
  return MODEL_NAMES[model] ?? model;
}

/** Compact name for one-line summaries: "Claude Opus 5.5" → "Opus 5.5". */
export function shortModelName(name: string): string {
  return name.replace(/^Claude /, '').replace(/^Grok Composer (\S+) Fast$/, 'Composer $1').replace(/^DeepSeek /, '').replace(/^Qwen3 Coder Plus$/, 'Qwen3 Coder');
}

export function formatClock(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'later';
}

/** "28 min", "1 hr 5 min" until the ISO time; "a moment" once it has passed. */
export function timeLeft(iso: string | null | undefined, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return 'a while';
  const min = Math.ceil((t - now) / 60_000);
  if (min <= 0) return 'a moment';
  if (min < 60) return `${ min } min`;
  return `${ Math.floor(min / 60) } hr${ min % 60 ? ` ${ min % 60 } min` : '' }`;
}

// ── List editing ──────────────────────────────────────────────────────────

export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return [...items];
  const next = [...items]; const [item] = next.splice(from, 1); next.splice(to, 0, item); return next;
}

export function rowKey(row: Pick<RoutingRow, 'provider' | 'class'>): string { return `${ row.provider }:${ row.class }`; }
export function modelKey(m: ClassModel): string { return `${ m.provider }/${ m.model }`; }

/** Only providers that run on this Mac may use the Local class. */
export function canUseClass(state: Pick<ModelRoutingState, 'providers'>, modelClass: ModelClass, providerId: string): boolean {
  return modelClass !== 'local' || !!findProvider(state, providerId)?.local;
}

/** Classes this provider has at least one model in. */
export function modelsForProvider(state: ModelRoutingState, provider: RoutingProviderInfo): ModelClass[] {
  return MODEL_CLASSES.filter(c => canUseClass(state, c, provider.id) && state.classes[c].some(m => m.provider === provider.id));
}

export interface ClassOption { value: ModelClass; label: string; disabled: boolean }

/** The class selector of one list row: classes the provider has models in, plus the row's own class even if it's empty. */
export function classOptions(state: ModelRoutingState, rows: readonly RoutingRow[], row: RoutingRow): ClassOption[] {
  return MODEL_CLASSES.filter(c => canUseClass(state, c, row.provider)).flatMap((c) => {
    const has = state.classes[c].some(m => m.provider === row.provider);
    if (!has && c !== row.class) return [];
    const taken = c !== row.class && rows.some(r => r !== row && r.provider === row.provider && r.class === c);
    return [{ value: c, label: `${ CLASS_LABELS[c] }${ has ? '' : ' (no models)' }${ taken ? ' (in list)' : '' }`, disabled: taken }];
  });
}

/** A row resolves to its provider's first model in that class's list (in the order Sulla tries them). */
export function resolvedModel(state: ModelRoutingState, row: Pick<RoutingRow, 'provider' | 'class'>): ClassModel | undefined {
  return orderedClassModels(state, row.class).find(m => m.provider === row.provider);
}

/** First appearance in the Agents list, then every other connected provider, then the rest. */
export function providerOrder(state: ModelRoutingState): string[] {
  return [...new Set([
    ...state.agentsList.map(r => r.provider),
    ...state.providers.filter(p => p.connected).map(p => p.id),
    ...state.providers.map(p => p.id),
  ])];
}

/** Stable sort of class models by provider order (models of the same provider keep their order). */
export function sortByProviderOrder(state: ModelRoutingState, models: readonly ClassModel[]): ClassModel[] {
  const order = providerOrder(state);
  const ix = (id: string) => { const i = order.indexOf(id); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  return models.map((m, i) => [m, i] as const).sort((a, b) => ix(a[0].provider) - ix(b[0].provider) || a[1] - b[1]).map(x => x[0]);
}

export function orderedClassModels(state: ModelRoutingState, modelClass: ModelClass): ClassModel[] {
  return state.followProviderOrder[modelClass] ? sortByProviderOrder(state, state.classes[modelClass]) : [...state.classes[modelClass]];
}

/** Class lists re-sorted wherever "Follow provider order" is on, so the saved order is the order Sulla tries. */
export function applyFollowOrder(state: ModelRoutingState): Record<ModelClass, ClassModel[]> {
  const out = {} as Record<ModelClass, ClassModel[]>;
  for (const c of MODEL_CLASSES) out[c] = orderedClassModels(state, c);
  return out;
}

export function sameModels(a: readonly ClassModel[], b: readonly ClassModel[]): boolean {
  return a.length === b.length && a.every((m, i) => modelKey(m) === modelKey(b[i]));
}

/** Models a class can add, grouped by connected provider in provider order. */
export function addModelGroups(state: ModelRoutingState, modelClass: ModelClass): { provider: RoutingProviderInfo; models: { id: string; label: string; added: boolean }[] }[] {
  const have = new Set(state.classes[modelClass].map(modelKey));
  return providerOrder(state)
    .map(id => findProvider(state, id)!)
    .filter(p => p?.connected && p.models.length && canUseClass(state, modelClass, p.id))
    .map(p => ({ provider: p, models: p.models.map(m => ({ id: m.id, label: modelName(state, p.id, m.id), added: have.has(`${ p.id }/${ m.id }`) })) }));
}

/** Provider + class pairs a list can add, grouped by connected provider in provider order. */
export function addRowGroups(state: ModelRoutingState, rows: readonly RoutingRow[]): { provider: RoutingProviderInfo; classes: { value: ModelClass; model?: ClassModel; inList: boolean }[] }[] {
  return providerOrder(state)
    .map(id => findProvider(state, id)!)
    .filter(p => p?.connected)
    .map(p => ({ provider: p, classes: modelsForProvider(state, p).map(c => ({ value: c, model: resolvedModel(state, { provider: p.id, class: c }), inList: rows.some(r => r.provider === p.id && r.class === c) })) }))
    .filter(g => g.classes.length);
}

// ── Availability and status ───────────────────────────────────────────────

export interface Availability { ok: boolean; kind?: 'cool' | 'err' | 'off'; why?: string }

/** Can this provider take a request right now? Cooldown is per provider, so it applies to every row and model of it. */
export function availability(state: Pick<ModelRoutingState, 'providers'>, providerId: string, now = Date.now()): Availability {
  const p = findProvider(state, providerId);
  if (!p || !p.connected || p.status === 'disconnected') return { ok: false, kind: 'off', why: 'Not connected' };
  if (p.status === 'cooling') {
    const until = p.coolingUntil ? Date.parse(p.coolingUntil) : NaN;
    if (Number.isFinite(until) && until <= now) return { ok: true };
    return { ok: false, kind: 'cool', why: `Usage limit until ${ formatClock(p.coolingUntil) }` };
  }
  if (p.status === 'error') return { ok: false, kind: 'err', why: p.lastError || 'Error' };
  if (p.status === 'skipped') return { ok: false, kind: 'off', why: 'Skipped' };
  return { ok: true };
}

export type ChipKind = 'ready' | 'cool' | 'err' | 'off';
export interface Chip { kind: ChipKind; label: string }

export function providerChip(state: Pick<ModelRoutingState, 'providers'>, providerId: string, now = Date.now()): Chip {
  const a = availability(state, providerId, now);
  if (a.ok) return { kind: 'ready', label: 'Ready' };
  if (a.kind === 'cool') return { kind: 'cool', label: `Cooling down until ${ formatClock(findProvider(state, providerId)?.coolingUntil) }` };
  if (a.kind === 'err') return { kind: 'err', label: 'Error' };
  return { kind: 'off', label: a.why ?? 'Skipped' };
}

/** The chip on a list row: Skipped, the provider's state, or "No Fast model" when the row can't resolve. */
export function rowChip(state: ModelRoutingState, row: RoutingRow, now = Date.now()): Chip {
  if (!row.enabled) return { kind: 'off', label: 'Skipped' };
  const chip = providerChip(state, row.provider, now);
  if (chip.kind !== 'ready') return chip;
  if (!resolvedModel(state, row)) return { kind: 'off', label: `No ${ CLASS_LABELS[row.class] } model` };
  return chip;
}

// ── Routing traces ────────────────────────────────────────────────────────

export type StepKind = 'use' | 'off' | 'missing' | 'cool' | 'err';
export interface TraceStep { index: number; row: RoutingRow; model?: ClassModel; kind: StepKind; why: string }
export interface ListTrace { steps: TraceStep[]; chosen?: TraceStep; next?: TraceStep; waits: TraceStep[] }

/**
 * Walk a list top to bottom: skip rows that are off, have no model in their class, or whose provider is
 * cooling down or erroring; use the first ready row. `next` is the row Sulla moves to if the chosen
 * provider hits a limit (other rows of the same provider would be cooling down too).
 */
export function traceRoute(state: ModelRoutingState, list: RoutingListKey, now = Date.now()): ListTrace {
  const rows = list === 'agents' ? state.agentsList : state.subconsciousList;
  const steps: TraceStep[] = []; const waits: TraceStep[] = []; let chosen: TraceStep | undefined; let next: TraceStep | undefined;
  for (const [index, row] of rows.entries()) {
    const model = resolvedModel(state, row); const a = availability(state, row.provider, now);
    if (chosen) {
      if (row.enabled && model && a.ok && row.provider !== chosen.row.provider) { next = { index, row, model, kind: 'use', why: '' }; break; }
      continue;
    }
    if (!row.enabled) { steps.push({ index, row, model, kind: 'off', why: 'Turned off' }); continue; }
    if (!model) { steps.push({ index, row, kind: 'missing', why: `No ${ CLASS_LABELS[row.class] } model` }); continue; }
    if (!a.ok) {
      const step: TraceStep = { index, row, model, kind: a.kind === 'cool' ? 'cool' : a.kind === 'err' ? 'err' : 'off', why: a.why ?? '' };
      steps.push(step); if (step.kind === 'cool') waits.push(step); continue;
    }
    chosen = { index, row, model, kind: 'use', why: '' }; steps.push(chosen);
  }
  return { steps, chosen, next, waits };
}

export interface ClassStep { model: ClassModel; kind: 'use' | 'cool' | 'err' | 'off'; why: string }
export interface ClassTrace { steps: ClassStep[]; chosen?: ClassModel; next?: ClassModel; waits: ClassModel[]; via?: ModelClass; empty: ModelClass[] }

/** An agent that asks for a class walks that class's whole model list; empty classes fall back (never in a loop). */
export function traceClass(state: ModelRoutingState, modelClass: ModelClass, now = Date.now(), seen: ModelClass[] = []): ClassTrace {
  const list = orderedClassModels(state, modelClass);
  if (!list.length) {
    const fb = CLASS_FALLBACK[modelClass];
    if (!fb || seen.includes(fb)) return { steps: [], waits: [], empty: [modelClass] };
    const r = traceClass(state, fb, now, [...seen, modelClass]);
    return { ...r, via: r.via ?? fb, empty: [modelClass, ...r.empty] };
  }
  const steps: ClassStep[] = []; const waits: ClassModel[] = []; let chosen: ClassModel | undefined; let next: ClassModel | undefined;
  for (const m of list) {
    const a = availability(state, m.provider, now);
    if (chosen) { if (a.ok && m.provider !== chosen.provider) { next = m; break; } continue; }
    if (!a.ok) { steps.push({ model: m, kind: a.kind ?? 'off', why: a.why ?? '' }); if (a.kind === 'cool') waits.push(m); continue; }
    steps.push({ model: m, kind: 'use', why: '' }); chosen = m;
  }
  return { steps, chosen, next, waits, empty: [] };
}

/** Fallback chain for a class: ['coding', 'standard', 'frontier'] — stops before repeating. */
export function fallbackChain(modelClass: ModelClass): ModelClass[] {
  const chain: ModelClass[] = [modelClass];
  for (let c = CLASS_FALLBACK[modelClass]; c && !chain.includes(c); c = CLASS_FALLBACK[c]) chain.push(c);
  return chain;
}

export interface SummaryPart { label: string; out?: boolean; more?: boolean }

/** Collapsed accordion line: "Opus 5.5 → GPT-5.5 → +2 more"; models that can't run right now are marked `out`. */
export function classSummary(state: ModelRoutingState, modelClass: ModelClass, now = Date.now()): SummaryPart[] {
  const parts = orderedClassModels(state, modelClass).map(m => ({ label: shortModelName(modelName(state, m.provider, m.model)), out: !availability(state, m.provider, now).ok }));
  return parts.length <= 3 ? parts : [...parts.slice(0, 2), { label: `+${ parts.length - 2 } more`, more: true }];
}

export function emptyClassText(modelClass: ModelClass): string {
  const fb = CLASS_FALLBACK[modelClass];
  return fb ? `No models. Agents asking for ${ CLASS_LABELS[modelClass] } will fall back to ${ CLASS_LABELS[fb] }.`
    : 'No models. Local has no fallback, so Local work won’t run until you add a model that runs on this Mac.';
}

export interface ClassNow { kind: 'ok' | 'cool' | 'off'; label: string; bold?: boolean; inUse?: string }

/** "What an agent asking for this class gets right now", shown at the right of each accordion header. */
export function classNow(state: ModelRoutingState, modelClass: ModelClass, now = Date.now()): ClassNow {
  const t = traceClass(state, modelClass, now);
  if (t.chosen) {
    if (t.via) return { kind: 'ok', label: `Uses ${ CLASS_LABELS[t.via] }` };
    return { kind: 'ok', label: shortModelName(modelName(state, t.chosen.provider, t.chosen.model)), bold: true, inUse: modelKey(t.chosen) };
  }
  if (t.waits.length) return { kind: 'cool', label: `Waiting until ${ formatClock(findProvider(state, t.waits[0].provider)?.coolingUntil) }` };
  return { kind: 'off', label: 'Won’t run' };
}

// ── Agent model choice ────────────────────────────────────────────────────

/** Short label for an agent's Model setting: "Agents list", "Class: Coding" or "Claude Code · claude-opus-5-5". */
export function choiceLabel(choice: AgentModelChoice | null | undefined, state?: Pick<ModelRoutingState, 'providers'> | null): string {
  if (!choice || choice.mode === 'list') return 'Agents list';
  if (choice.mode === 'class') return `Class: ${ CLASS_LABELS[choice.class] ?? choice.class }`;
  return `${ providerName(state, choice.provider) } · ${ choice.model }`;
}

export interface ChoiceResolution { model?: string; text: string; warn?: boolean }

/** What an agent's Model setting resolves to right now ("Right now: <model> through …"). */
export function resolveChoice(state: ModelRoutingState, choice: AgentModelChoice, now = Date.now()): ChoiceResolution {
  if (choice.mode === 'pin') {
    const name = providerName(state, choice.provider); const p = findProvider(state, choice.provider);
    if (!p?.connected) return { text: `${ name } isn’t connected. A pinned agent doesn’t fall back, so it can’t run.`, warn: true };
    const a = availability(state, choice.provider, now);
    if (a.kind === 'cool') return { text: `${ name } is cooling down until ${ formatClock(p.coolingUntil) }. A pinned agent doesn’t fall back, so this agent waits until then.`, warn: true };
    if (a.kind === 'err') return { text: `${ name }: ${ a.why }. A pinned agent doesn’t fall back.`, warn: true };
    return { text: `A pinned agent doesn’t fall back. If ${ name } hits its limit, this agent waits until it resets.`, warn: true };
  }
  if (choice.mode === 'list') {
    const t = traceRoute(state, 'agents', now);
    if (t.chosen?.model) return { model: t.chosen.model.model, text: `through ${ providerName(state, t.chosen.row.provider) } (Agents row ${ t.chosen.index + 1 }, ${ CLASS_LABELS[t.chosen.row.class] })` };
    if (t.waits.length) return { text: `waiting for ${ providerName(state, t.waits[0].row.provider) } at ${ formatClock(findProvider(state, t.waits[0].row.provider)?.coolingUntil) }`, warn: true };
    return { text: 'nothing in the Agents list can run', warn: true };
  }
  const t = traceClass(state, choice.class, now);
  if (t.chosen) return { model: t.chosen.model, text: `through ${ providerName(state, t.chosen.provider) }${ t.via ? ` (${ CLASS_LABELS[choice.class] } is empty, so it uses ${ CLASS_LABELS[t.via] })` : '' }` };
  if (t.waits.length) return { text: `waiting for ${ providerName(state, t.waits[0].provider) } at ${ formatClock(findProvider(state, t.waits[0].provider)?.coolingUntil) }`, warn: true };
  return { text: `no model in ${ CLASS_LABELS[choice.class] } can run`, warn: true };
}
