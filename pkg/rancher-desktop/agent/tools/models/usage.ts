import { SullaSettingsModel } from '../../database/models/SullaSettingsModel';
import { MeterableUsageModel } from '../../database/models/MeterableUsageModel';
import { BaseTool, ToolResponse } from '../base';

type UsageRecord = Record<string, unknown> & {
  ts?:                          string;
  model?:                       string;
  input_tokens?:                number;
  output_tokens?:               number;
  cached_input_tokens?:         number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?:     number;
  cost_usd?:                    number;
  duration_ms?:                 number;
};

const USAGE_SETTINGS: Record<string, string> = {
  'claude-code': 'claudeCodeUsage',
  codex:         'codexUsage',
};

export class ModelsUsageWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const providerFilter = typeof input.provider === 'string' && input.provider.trim()
      ? input.provider.trim()
      : undefined;
    const modelFilter = typeof input.model === 'string' && input.model.trim()
      ? input.model.trim()
      : undefined;
    const hours = typeof input.hours === 'number' && Number.isFinite(input.hours) && input.hours > 0
      ? input.hours
      : 24;
    const sinceMs = Date.now() - hours * 60 * 60 * 1000;

    const providerIds = providerFilter ? [providerFilter] : Object.keys(USAGE_SETTINGS);
    const unsupported = providerIds.filter(providerId => !USAGE_SETTINGS[providerId]);
    const supported = providerIds.filter(providerId => USAGE_SETTINGS[providerId]);

    const records = (await Promise.all(supported.map(async(providerId) => {
      const raw = await SullaSettingsModel.get(USAGE_SETTINGS[providerId], '[]');
      return parseUsage(raw)
        .filter(record => isInWindow(record, sinceMs))
        .filter(record => !modelFilter || record.model === modelFilter)
        .map(record => ({ provider: providerId, ...record }));
    }))).flat();

    const totals = records.reduce((acc, record) => {
      acc.input_tokens += asNumber(record.input_tokens);
      acc.output_tokens += asNumber(record.output_tokens);
      acc.cached_input_tokens += asNumber(record.cached_input_tokens);
      acc.cache_creation_input_tokens += asNumber(record.cache_creation_input_tokens);
      acc.cache_read_input_tokens += asNumber(record.cache_read_input_tokens);
      acc.cost_usd += asNumber(record.cost_usd);
      acc.duration_ms += asNumber(record.duration_ms);
      return acc;
    }, {
      input_tokens:                0,
      output_tokens:               0,
      cached_input_tokens:         0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens:     0,
      cost_usd:                    0,
      duration_ms:                 0,
    });

    const byProviderModel: Record<string, typeof totals & { provider: string; model: string; records: number }> = {};
    for (const record of records) {
      const provider = String(record.provider);
      const model = typeof record.model === 'string' && record.model ? record.model : '(unknown)';
      const key = `${ provider }:${ model }`;
      byProviderModel[key] ??= {
        provider,
        model,
        records:                     0,
        input_tokens:                0,
        output_tokens:               0,
        cached_input_tokens:         0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens:     0,
        cost_usd:                    0,
        duration_ms:                 0,
      };
      byProviderModel[key].records += 1;
      byProviderModel[key].input_tokens += asNumber(record.input_tokens);
      byProviderModel[key].output_tokens += asNumber(record.output_tokens);
      byProviderModel[key].cached_input_tokens += asNumber(record.cached_input_tokens);
      byProviderModel[key].cache_creation_input_tokens += asNumber(record.cache_creation_input_tokens);
      byProviderModel[key].cache_read_input_tokens += asNumber(record.cache_read_input_tokens);
      byProviderModel[key].cost_usd += asNumber(record.cost_usd);
      byProviderModel[key].duration_ms += asNumber(record.duration_ms);
    }

    return {
      successBoolean: true,
      responseString: JSON.stringify({
        source: 'SullaSettingsModel local rolling usage telemetry',
        note:   unsupported.length > 0
          ? `Provider usage is locally tracked for ${ Object.keys(USAGE_SETTINGS).join(', ') }. Unsupported filters: ${ unsupported.join(', ') }.`
          : 'Provider billing dashboards are not queried; this reports usage Sulla captured from model runs.',
        windowHours: hours,
        filters:     {
          provider: providerFilter ?? null,
          model:    modelFilter ?? null,
        },
        records:         records.length,
        totals,
        byProviderModel: Object.values(byProviderModel),
        meterableUsage: await MeterableUsageModel.totals('default', new Date(sinceMs)).catch(() => []),
      }, null, 2),
    };
  }
}

function parseUsage(raw: unknown): UsageRecord[] {
  if (Array.isArray(raw)) return raw.filter(isObject) as UsageRecord[];
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isObject) as UsageRecord[] : [];
  } catch {
    return [];
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInWindow(record: UsageRecord, sinceMs: number): boolean {
  const timestamp = typeof record.ts === 'string' ? Date.parse(record.ts) : NaN;
  return Number.isFinite(timestamp) && timestamp >= sinceMs;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
