import { MeterableUsageModel, type MeterableUsageRecord } from '../database/models/MeterableUsageModel';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';

export interface CliUsageRecord {
  ts:                           string;
  model?:                       string;
  input_tokens?:                number;
  output_tokens?:               number;
  total_tokens?:                number;
  cached_input_tokens?:         number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?:     number;
  cost_usd?:                    number;
  duration_ms?:                 number;
}

export interface UsageLimitWindow {
  id:             string;
  label:          string;
  usedPercent:    number;
  resetsAt?:      string;
  windowMinutes?: number;
}

export interface UsageLimitSnapshot {
  providerId: string;
  capturedAt: string;
  windows:    UsageLimitWindow[];
}

type UsageSource =
  | { kind: 'settings'; key: string }
  | { kind: 'meterable'; providerId: string };

export interface UsageProviderDefinition {
  id:          string;
  label:       string;
  usageSource: UsageSource;
  limitSource?: { kind: 'settings'; key: string };
}

/**
 * The single provider registry used by capture, the Usage page and the
 * models/usage tool. A new CLI engine needs one settings entry and calls to
 * recordCliUsage / recordCliLimitSnapshot; API providers use the ledger.
 */
export const USAGE_PROVIDER_REGISTRY: Record<string, UsageProviderDefinition> = {
  'claude-code': {
    id: 'claude-code', label: 'Claude Code', usageSource: { kind: 'settings', key: 'claudeCodeUsage' }, limitSource: { kind: 'settings', key: 'claudeCodeLimitSnapshot' },
  },
  codex: {
    id: 'codex', label: 'Codex', usageSource: { kind: 'settings', key: 'codexUsage' }, limitSource: { kind: 'settings', key: 'codexLimitSnapshot' },
  },
  opencode: {
    id: 'opencode', label: 'OpenCode', usageSource: { kind: 'settings', key: 'opencodeUsage' },
  },
  cursor: {
    id: 'cursor', label: 'Cursor', usageSource: { kind: 'settings', key: 'cursorUsage' },
  },
  grok: {
    id: 'grok', label: 'Grok', usageSource: { kind: 'meterable', providerId: 'grok' },
  },
  anthropic: {
    id: 'anthropic', label: 'Anthropic API', usageSource: { kind: 'meterable', providerId: 'anthropic' },
  },
  openai: {
    id: 'openai', label: 'OpenAI API', usageSource: { kind: 'meterable', providerId: 'openai' },
  },
  google: {
    id: 'google', label: 'Google API', usageSource: { kind: 'meterable', providerId: 'google' },
  },
  kimi: {
    id: 'kimi', label: 'Kimi API', usageSource: { kind: 'meterable', providerId: 'kimi' },
  },
  nvidia: {
    id: 'nvidia', label: 'NVIDIA API', usageSource: { kind: 'meterable', providerId: 'nvidia' },
  },
  alibaba: {
    id: 'alibaba', label: 'Alibaba API', usageSource: { kind: 'meterable', providerId: 'alibaba' },
  },
  cohere: {
    id: 'cohere', label: 'Cohere API', usageSource: { kind: 'meterable', providerId: 'cohere' },
  },
  deepseek: {
    id: 'deepseek', label: 'DeepSeek API', usageSource: { kind: 'meterable', providerId: 'deepseek' },
  },
  arcee: {
    id: 'arcee', label: 'Arcee API', usageSource: { kind: 'meterable', providerId: 'arcee' },
  },
  custom: {
    id: 'custom', label: 'Custom API', usageSource: { kind: 'meterable', providerId: 'custom' },
  },
};

const RETENTION_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 10_000;
const writeQueues = new Map<string, Promise<void>>();

export async function recordCliUsage(providerId: string, record: Omit<CliUsageRecord, 'ts'> & { ts?: string }): Promise<void> {
  const provider = USAGE_PROVIDER_REGISTRY[providerId];
  const key = provider?.usageSource.kind === 'settings'
    ? provider.usageSource.key
    : `${ providerId }Usage`;

  await enqueueWrite(key, async() => {
    const records = parseRecords(await SullaSettingsModel.get(key, '[]'));
    const entry = sanitizeRecord({ ...record, ts: record.ts ?? new Date().toISOString() });
    const cutoff = Date.now() - RETENTION_MS;
    const retained = [...records, entry]
      .filter(item => Number.isFinite(Date.parse(item.ts)) && Date.parse(item.ts) >= cutoff)
      .slice(-MAX_RECORDS);

    await SullaSettingsModel.set(key, JSON.stringify(retained));
  });
}

export async function recordCliLimitSnapshot(providerId: string, snapshot: UsageLimitSnapshot): Promise<void> {
  const provider = USAGE_PROVIDER_REGISTRY[providerId];
  const key = provider?.limitSource?.key ?? `${ providerId }LimitSnapshot`;

  await enqueueWrite(key, async() => {
    const current = parseLimitSnapshot(await SullaSettingsModel.get(key, null));
    const merged = new Map<string, UsageLimitWindow>();
    for (const window of current?.windows ?? []) merged.set(window.id, window);
    for (const window of snapshot.windows) merged.set(window.id, window);
    await SullaSettingsModel.set(key, JSON.stringify({
      providerId,
      capturedAt: snapshot.capturedAt,
      windows: [...merged.values()],
    } satisfies UsageLimitSnapshot));
  });
}

export function normalizeClaudeLimitSnapshot(event: unknown): UsageLimitSnapshot | null {
  if (!isObject(event)) return null;
  const type = String(event.type ?? event.event ?? '').toLowerCase();
  const payload = firstObject(event.rate_limit, event.rate_limit_info, event.rate_limits, event.data);
  if (!type.includes('rate_limit') && !payload) return null;
  const source = payload ?? event;
  const windows = collectLimitWindows(source, [
    ['five_hour', '5-hour'], ['fiveHour', '5-hour'], ['primary', 'Primary'],
    ['weekly', 'Weekly'], ['seven_day', 'Weekly'], ['seven_day_opus', 'Weekly · Opus'],
    ['seven_day_sonnet', 'Weekly · Sonnet'], ['secondary', 'Secondary'],
  ]);
  if (windows.length === 0) {
    const single = parseLimitWindow(source, String(source.rate_limit_type ?? source.window ?? 'current'), undefined);
    if (single) windows.push(single);
  }
  return windows.length ? { providerId: 'claude-code', capturedAt: new Date().toISOString(), windows } : null;
}

export function normalizeCodexLimitSnapshot(event: unknown): UsageLimitSnapshot | null {
  if (!isObject(event)) return null;
  const msg = isObject(event.msg) ? event.msg : undefined;
  const info = isObject(msg?.info) ? msg.info : undefined;
  const payload = firstObject(event.rate_limits, isObject(event.usage) ? event.usage.rate_limits : undefined, msg?.rate_limits, info?.rate_limits);
  if (!payload) return null;
  const windows = collectLimitWindows(payload, [
    ['primary', 'Primary'], ['primary_window', 'Primary'],
    ['secondary', 'Secondary'], ['secondary_window', 'Secondary'],
  ]);
  return windows.length ? { providerId: 'codex', capturedAt: new Date().toISOString(), windows } : null;
}

export interface UsageSummary {
  generatedAt: string;
  windowHours: number;
  profileId:   string;
  totals:      UsageAggregate;
  providers:   ProviderUsageSummary[];
  models:      ModelUsageSummary[];
  daily:       DailyUsageSummary[];
  limits:      Record<string, UsageLimitSnapshot | null>;
}

export interface UsageAggregate {
  totalTokens:        number;
  inputTokens:        number;
  outputTokens:       number;
  cacheReadTokens:    number;
  cacheWriteTokens:   number;
  estimatedCostUsd:   number;
  cacheSavingsUsd:    number;
  pricedTokens:       number;
}

export interface ProviderUsageSummary extends UsageAggregate {
  id:      string;
  label:   string;
  records: number;
}

export interface ModelUsageSummary extends UsageAggregate {
  providerId:                    string;
  providerLabel:                 string;
  model:                         string;
  records:                       number;
  cacheHitRate:                  number;
  estimatedCostPerMillionTokens: number | null;
}

export interface DailyUsageSummary extends UsageAggregate {
  date: string;
}

interface NormalizedUsageRecord extends CliUsageRecord {
  providerId:    string;
  providerLabel: string;
}

export async function getUsageSummary(hours = 24, profileId = 'default', providerFilter?: string): Promise<UsageSummary> {
  const safeHours = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 31) : 24;
  const since = new Date(Date.now() - safeHours * 60 * 60 * 1000);
  const definitions = Object.values(USAGE_PROVIDER_REGISTRY)
    .filter(provider => !providerFilter || provider.id === providerFilter);
  const meterable = await MeterableUsageModel.records(profileId, since).catch(() => []);
  const records: NormalizedUsageRecord[] = [];

  for (const provider of definitions) {
    const source = provider.usageSource;

    if (source.kind === 'settings') {
      const stored = parseRecords(await SullaSettingsModel.get(source.key, '[]'));
      records.push(...stored.filter(record => Date.parse(record.ts) >= since.getTime()).map(record => ({
        ...record, providerId: provider.id, providerLabel: provider.label,
      })));
    } else {
      records.push(...meterable
        .filter(record => meterableProviderId(record) === source.providerId)
        .map(record => fromMeterable(record, provider)));
    }
  }

  const knownMeterableProviders = new Set(definitions
    .filter(provider => provider.usageSource.kind === 'meterable')
    .map(provider => (provider.usageSource as Extract<UsageSource, { kind: 'meterable' }>).providerId));
  if (!providerFilter) {
    for (const record of meterable) {
      const providerId = meterableProviderId(record);
      if (!providerId || knownMeterableProviders.has(providerId) || providerId === 'claude-code' || providerId === 'codex') continue;
      records.push(fromMeterable(record, {
        id: providerId, label: humanize(providerId), usageSource: { kind: 'meterable', providerId },
      }));
    }
  }

  const providers = definitions.map(provider => summarizeProvider(provider, records.filter(record => record.providerId === provider.id)));
  const dynamicIds = [...new Set(records.map(record => record.providerId))]
    .filter(id => !definitions.some(provider => provider.id === id));
  for (const id of dynamicIds) {
    const providerRecords = records.filter(record => record.providerId === id);
    providers.push(summarizeProvider({ id, label: providerRecords[0]?.providerLabel ?? humanize(id), usageSource: { kind: 'meterable', providerId: id } }, providerRecords));
  }

  const limits: Record<string, UsageLimitSnapshot | null> = {};
  for (const provider of definitions) {
    limits[provider.id] = provider.limitSource
      ? parseLimitSnapshot(await SullaSettingsModel.get(provider.limitSource.key, null))
      : null;
  }

  return {
    generatedAt: new Date().toISOString(),
    windowHours: safeHours,
    profileId,
    totals: summarize(records),
    providers,
    models: summarizeModels(records),
    daily: summarizeDaily(records, since),
    limits,
  };
}

function fromMeterable(record: MeterableUsageRecord, provider: UsageProviderDefinition): NormalizedUsageRecord {
  const metadata = record.metadata ?? {};
  const input = finiteNumber(metadata.input_tokens ?? metadata.prompt_tokens);
  const output = finiteNumber(metadata.output_tokens ?? metadata.completion_tokens);
  return {
    ...sanitizeRecord({
      ts: record.created_at,
      model: typeof metadata.model === 'string' ? metadata.model : undefined,
      input_tokens: input || undefined,
      output_tokens: output || undefined,
      total_tokens: Number(record.quantity),
      cached_input_tokens: finiteNumber(metadata.cached_input_tokens) || undefined,
      cache_read_input_tokens: finiteNumber(metadata.cache_read_input_tokens) || undefined,
      cache_creation_input_tokens: finiteNumber(metadata.cache_creation_input_tokens) || undefined,
    }),
    providerId: provider.id,
    providerLabel: provider.label,
  };
}

function meterableProviderId(record: MeterableUsageRecord): string {
  const metadataProvider = record.metadata && typeof record.metadata.provider === 'string' ? record.metadata.provider : '';
  return metadataProvider || record.source.replace(/^model:/, '');
}

function summarizeProvider(provider: UsageProviderDefinition, records: NormalizedUsageRecord[]): ProviderUsageSummary {
  return { id: provider.id, label: provider.label, records: records.length, ...summarize(records) };
}

function summarizeModels(records: NormalizedUsageRecord[]): ModelUsageSummary[] {
  const groups = new Map<string, NormalizedUsageRecord[]>();
  for (const record of records) {
    const model = record.model || '(unknown model)';
    const key = `${ record.providerId }\u0000${ model }`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    const aggregate = summarize(group);
    const cacheEligible = aggregate.inputTokens + aggregate.cacheReadTokens;
    return {
      providerId: group[0].providerId,
      providerLabel: group[0].providerLabel,
      model: group[0].model || '(unknown model)',
      records: group.length,
      ...aggregate,
      cacheHitRate: cacheEligible > 0 ? aggregate.cacheReadTokens / cacheEligible : 0,
      estimatedCostPerMillionTokens: aggregate.pricedTokens > 0
        ? aggregate.estimatedCostUsd / aggregate.pricedTokens * 1_000_000
        : null,
    };
  }).sort((a, b) => b.totalTokens - a.totalTokens);
}

function summarizeDaily(records: NormalizedUsageRecord[], since: Date): DailyUsageSummary[] {
  const days = new Map<string, NormalizedUsageRecord[]>();
  const cursor = new Date(since);
  cursor.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  while (cursor <= today) {
    days.set(localDateKey(cursor), []);
    cursor.setDate(cursor.getDate() + 1);
  }
  for (const record of records) {
    const key = localDateKey(new Date(record.ts));
    if (days.has(key)) days.get(key)!.push(record);
  }
  return [...days].map(([date, dayRecords]) => ({ date, ...summarize(dayRecords) }));
}

function summarize(records: CliUsageRecord[]): UsageAggregate {
  const aggregate: UsageAggregate = {
    totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, estimatedCostUsd: 0, cacheSavingsUsd: 0, pricedTokens: 0,
  };
  for (const record of records) {
    const input = finiteNumber(record.input_tokens);
    const output = finiteNumber(record.output_tokens);
    const cacheRead = finiteNumber(record.cache_read_input_tokens ?? record.cached_input_tokens);
    const cacheWrite = finiteNumber(record.cache_creation_input_tokens);
    const total = finiteNumber(record.total_tokens) || input + output;
    const estimate = estimateCost(record, total, input, output, cacheRead, cacheWrite);
    aggregate.totalTokens += total;
    aggregate.inputTokens += input;
    aggregate.outputTokens += output;
    aggregate.cacheReadTokens += cacheRead;
    aggregate.cacheWriteTokens += cacheWrite;
    aggregate.estimatedCostUsd += estimate.cost;
    aggregate.cacheSavingsUsd += estimate.cacheSavings;
    aggregate.pricedTokens += estimate.priced ? total : 0;
  }
  return aggregate;
}

interface ModelPrice { input: number; output: number; cacheRead?: number; cacheWrite?: number }

// Public API prices move over time. These are deliberately treated and shown
// as estimates; unknown models remain unpriced instead of inheriting a guess.
const PRICE_PATTERNS: Array<[RegExp, ModelPrice]> = [
  [/claude.*opus/i, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  [/claude.*sonnet/i, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  [/claude.*haiku/i, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  [/gpt-5/i, { input: 1.25, output: 10, cacheRead: 0.125 }],
  [/gpt-4\.1/i, { input: 2, output: 8, cacheRead: 0.5 }],
  [/gpt-4o/i, { input: 2.5, output: 10, cacheRead: 1.25 }],
  [/grok.*fast/i, { input: 0.2, output: 0.5, cacheRead: 0.05 }],
  [/grok/i, { input: 3, output: 15, cacheRead: 0.75 }],
  [/gemini.*flash/i, { input: 0.3, output: 2.5, cacheRead: 0.03 }],
  [/gemini.*pro/i, { input: 1.25, output: 10, cacheRead: 0.125 }],
  [/deepseek/i, { input: 0.28, output: 0.42, cacheRead: 0.028 }],
];

function estimateCost(record: CliUsageRecord, total: number, input: number, output: number, cacheRead: number, cacheWrite: number): { cost: number; cacheSavings: number; priced: boolean } {
  const price = PRICE_PATTERNS.find(([pattern]) => pattern.test(record.model ?? ''))?.[1];
  if (!price) {
    const recorded = finiteNumber(record.cost_usd);
    return { cost: recorded, cacheSavings: 0, priced: recorded > 0 };
  }
  const cacheReadRate = price.cacheRead ?? price.input;
  const cacheWriteRate = price.cacheWrite ?? price.input;
  const estimatedInput = input === 0 && output === 0 ? total : input;
  return {
    cost: ((estimatedInput * price.input) + (output * price.output) + (cacheRead * cacheReadRate) + (cacheWrite * cacheWriteRate)) / 1_000_000,
    cacheSavings: cacheRead * Math.max(0, price.input - cacheReadRate) / 1_000_000,
    priced: true,
  };
}

function collectLimitWindows(source: Record<string, unknown>, keys: Array<[string, string]>): UsageLimitWindow[] {
  const windows: UsageLimitWindow[] = [];
  const seen = new Set<string>();
  for (const [key, label] of keys) {
    if (seen.has(key) || !isObject(source[key])) continue;
    const parsed = parseLimitWindow(source[key] as Record<string, unknown>, key, label);
    if (parsed) windows.push(parsed);
    seen.add(key);
  }
  return windows;
}

function parseLimitWindow(source: Record<string, unknown>, id: string, label?: string): UsageLimitWindow | null {
  let used = finiteNumber(source.usedPercent ?? source.used_percentage ?? source.used_percent ?? source.percent_used ?? source.utilization ?? source.used);
  if (used > 0 && used <= 1 && source.usedPercent === undefined && source.used_percentage === undefined && source.used_percent === undefined && source.percent_used === undefined) used *= 100;
  if (!Number.isFinite(used) || (used === 0 && !('usedPercent' in source) && !('used_percentage' in source) && !('used_percent' in source) && !('percent_used' in source) && !('utilization' in source) && !('used' in source))) return null;
  const resets = source.resets_at ?? source.reset_at ?? source.reset_time ?? source.resetsAt ?? source.resetAt;
  const windowMinutes = finiteNumber(source.window_minutes ?? source.windowMinutes ?? source.limit_window_seconds) / (source.limit_window_seconds ? 60 : 1);
  const derivedLabel = windowMinutes === 300 ? '5-hour' : windowMinutes === 10_080 ? 'Weekly' : undefined;
  return {
    id,
    label: derivedLabel ?? label ?? limitLabel(id),
    usedPercent: Math.max(0, Math.min(100, used)),
    resetsAt: normalizeResetTime(resets),
    windowMinutes: windowMinutes || undefined,
  };
}

function normalizeResetTime(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
  }
  return undefined;
}

function parseRecords(raw: unknown): CliUsageRecord[] {
  const parsed = typeof raw === 'string' ? safeJson(raw) : raw;
  return Array.isArray(parsed) ? parsed.filter(isObject).map(record => sanitizeRecord(record as CliUsageRecord)) : [];
}

function parseLimitSnapshot(raw: unknown): UsageLimitSnapshot | null {
  const parsed = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!isObject(parsed) || !Array.isArray(parsed.windows)) return null;
  const windows = parsed.windows.filter(isObject).map(window => parseLimitWindow(window, String(window.id ?? 'window'), typeof window.label === 'string' ? window.label : undefined)).filter(Boolean) as UsageLimitWindow[];
  return windows.length ? {
    providerId: String(parsed.providerId ?? ''),
    capturedAt: typeof parsed.capturedAt === 'string' ? parsed.capturedAt : new Date().toISOString(),
    windows,
  } : null;
}

function sanitizeRecord(record: CliUsageRecord): CliUsageRecord {
  return {
    ts: typeof record.ts === 'string' ? record.ts : new Date().toISOString(),
    model: typeof record.model === 'string' ? record.model : undefined,
    input_tokens: finiteOrUndefined(record.input_tokens),
    output_tokens: finiteOrUndefined(record.output_tokens),
    total_tokens: finiteOrUndefined(record.total_tokens),
    cached_input_tokens: finiteOrUndefined(record.cached_input_tokens),
    cache_creation_input_tokens: finiteOrUndefined(record.cache_creation_input_tokens),
    cache_read_input_tokens: finiteOrUndefined(record.cache_read_input_tokens),
    cost_usd: finiteOrUndefined(record.cost_usd),
    duration_ms: finiteOrUndefined(record.duration_ms),
  };
}

function enqueueWrite(key: string, operation: () => Promise<void>): Promise<void> {
  const queued = (writeQueues.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  let tracked: Promise<void>;
  tracked = queued.finally(() => {
    if (writeQueues.get(key) === tracked) writeQueues.delete(key);
  });
  writeQueues.set(key, tracked);
  return tracked;
}

function firstObject(...values: unknown[]): Record<string, unknown> | undefined {
  return values.find(isObject) as Record<string, unknown> | undefined;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value) } catch { return null }
}

function finiteNumber(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function finiteOrUndefined(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return value === undefined || value === null || value === '' ? undefined : number;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${ year }-${ month }-${ day }`;
}

function humanize(value: string): string {
  return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function limitLabel(value: string): string {
  if (/five.?hour|session/i.test(value)) return '5-hour';
  if (/week|seven.?day/i.test(value)) return 'Weekly';
  return humanize(value);
}
