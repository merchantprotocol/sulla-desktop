/**
 * Refuse agent Redis-tool access to the `sulla_settings` hash.
 *
 * SullaSettingsModel is the single authoritative settings path
 * (Redis cache → Postgres on miss → write-through both). A raw
 * hget can serve a stale cache; a raw hset/del desyncs the stores.
 * Product code already goes through the model — this guard closes
 * the remaining hole: the agent redis_* tools.
 */
import type { ToolResponse } from '../base';

export const SULLA_SETTINGS_HASH = 'sulla_settings';

export function blockedSettingsKey(keyOrKeys: unknown): string | null {
  const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
  const hit = keys.some(k => typeof k === 'string' && k === SULLA_SETTINGS_HASH);
  if (!hit) return null;

  return [
    'Blocked: Redis key `sulla_settings` is owned by SullaSettingsModel.',
    'Read with `sulla settings/settings_get` and write with `sulla settings/settings_set`.',
    'A raw Redis read can serve a stale cache; a raw write desyncs Redis from Postgres.',
  ].join(' ');
}

/** Return a failed ToolResponse if `key` (or any of `keys`) is the settings hash. */
export function rejectSettingsBypass(
  keyOrKeys: unknown,
  _field?: unknown,
  _op?: string,
): ToolResponse | null {
  const msg = blockedSettingsKey(keyOrKeys);
  if (!msg) return null;
  return { successBoolean: false, responseString: msg };
}
