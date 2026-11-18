// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The tool's protected-settings guard pulls in Desktop main-process modules; the
// write path under test doesn't depend on it.
vi.mock('@pkg/main/cloud/cloudSettings', () => ({ isProtectedSetting: () => false }));

// In-memory stand-in for SullaSettingsModel. It stores json/array values as a
// JSON string and parses them back on read, like the real model does.
const store = new Map<string, { raw: string; cast?: string }>();

vi.mock('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: {
    get: vi.fn(async (property: string, fallback: any = null) => {
      const entry = store.get(property);
      if (!entry) return fallback;
      return entry.cast === 'json' || entry.cast === 'array' ? JSON.parse(entry.raw) : entry.raw;
    }),
    set: vi.fn(async (property: string, value: any, cast?: string) => {
      const raw = cast === 'json' || cast === 'array' ? JSON.stringify(value) : String(value);
      store.set(property, { raw, cast });
    }),
  },
}));

vi.mock('@pkg/main/cloud/cloudSettings', () => ({ isProtectedSetting: () => false }));

import { SullaSettingsModel } from '../../database/models/SullaSettingsModel';

import { SettingsSetWorker } from './set';

describe('SettingsSetWorker', () => {
  let tool: SettingsSetWorker;
  const run = (input: Record<string, unknown>) => (tool as any)._validatedCall(input);

  beforeEach(() => {
    store.clear();
    vi.mocked(SullaSettingsModel.set).mockClear();
    tool = new SettingsSetWorker();
  });

  // risk: object settings like modelRouting were stored double-encoded and read back as strings
  it('stores a json-cast string as an object so it reads back as an object', async () => {
    const result = await run({ property: 'modelRouting', value: '{"primary":"codex","fallback":["claude"]}', cast: 'json' });

    expect(result.successBoolean).toBe(true);
    expect(SullaSettingsModel.set).toHaveBeenCalledWith('modelRouting', { primary: 'codex', fallback: ['claude'] }, 'json');
    expect(await SullaSettingsModel.get('modelRouting', null)).toEqual({ primary: 'codex', fallback: ['claude'] });
  });

  // risk: a malformed value must never overwrite a stored setting
  it('rejects invalid JSON with a clear error and writes nothing', async () => {
    store.set('modelRouting', { raw: '{"primary":"codex"}', cast: 'json' });

    const result = await run({ property: 'modelRouting', value: '{"primary": ', cast: 'json' });

    expect(result.successBoolean).toBe(false);
    expect(result.responseString).toContain('NOT written');
    expect(SullaSettingsModel.set).not.toHaveBeenCalled();
    expect(store.get('modelRouting')?.raw).toBe('{"primary":"codex"}');
  });

  // risk: a plain string silently replacing an object/array setting breaks its consumers
  it('refuses a plain-string overwrite of an object setting', async () => {
    store.set('modelRouting', { raw: '{"primary":"codex"}', cast: 'json' });

    const noCast = await run({ property: 'modelRouting', value: 'claude' });
    const stringCast = await run({ property: 'modelRouting', value: 'claude', cast: 'string' });

    expect(noCast.successBoolean).toBe(false);
    expect(stringCast.successBoolean).toBe(false);
    expect(noCast.responseString).toContain('cast "json"');
    expect(SullaSettingsModel.set).not.toHaveBeenCalled();
  });

  // risk: the guard must not block ordinary string settings
  it('still overwrites an existing plain string setting', async () => {
    store.set('remoteProvider', { raw: 'old-provider' });

    const result = await run({ property: 'remoteProvider', value: 'new-provider' });

    expect(result.successBoolean).toBe(true);
    expect(SullaSettingsModel.set).toHaveBeenCalledWith('remoteProvider', 'new-provider', undefined);
    expect(store.get('remoteProvider')?.raw).toBe('new-provider');
  });
});
