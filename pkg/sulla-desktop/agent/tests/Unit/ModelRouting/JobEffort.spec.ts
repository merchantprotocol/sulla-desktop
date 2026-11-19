// SPDX-License-Identifier: GPL-2.0-or-later
import '../../Support/TestHomeEnv';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { ModelDispatchService } from '@pkg/agent/languagemodels/ModelDispatchService';
import { ModelRouter } from '@pkg/agent/languagemodels/modelRouter';
import { effectiveModelChoice } from '@pkg/agent/languagemodels/threadModelChoice';

vi.mock('@pkg/agent/languagemodels/index', () => ({ PROVIDER_FACTORIES: { codex: {} } }));

const catalog = [{ id: 'gpt-6-luna', efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'max' }] }];
function router(models = catalog) {
  vi.spyOn(SullaSettingsModel, 'set').mockResolvedValue(undefined as never);
  vi.spyOn(SullaSettingsModel, 'get').mockImplementation((_key:string, fallback:any) => Promise.resolve(fallback));
  return new ModelRouter(() => ({ getAvailableProviders: () => Promise.resolve([{ id: 'codex', connected: true }]), getModelsForProvider: () => Promise.resolve(models) }));
}
afterEach(() => vi.restoreAllMocks());
describe('explicit per-job Codex effort', () => {
  it('delivers Luna max through the real routing/dispatch boundary', async() => {
    const route = router(); const create = vi.fn(() => Promise.resolve({} as any));
    const dispatch = new ModelDispatchService((target, choice) => route.resolve(target, choice), create);
    await dispatch.resolve('agents', effectiveModelChoice({ model: 'gpt-6-luna', effort: 'max' }));
    expect(create).toHaveBeenCalledWith('codex', 'gpt-6-luna', 'max');
  });
  it('preserves the provider default when effort is omitted', async() => {
    const route = router();
    expect(await route.resolve('agents', effectiveModelChoice({ model: 'gpt-6-luna' }))).toEqual([{ provider: 'codex', model: 'gpt-6-luna' }]);
  });
  it('rejects an unsupported effort and missing catalog instead of quietly defaulting', async() => {
    const route = router();
    await expect(route.resolve('agents', { mode: 'pin', provider: 'codex', model: 'gpt-6-luna', effort: 'ultra' } as any)).rejects.toThrow(/effort/i);
    await expect(route.resolve('agents', { mode: 'pin', provider: 'codex', model: 'missing-model', effort: 'max' } as any)).rejects.toThrow(/effort/i);
  });
  it('requires a concrete Codex model so an effort cannot leak into a different provider or role', () => {
    for (const input of [{ effort: 'max' }, { model: 'primary', effort: 'max' }, { model: 'gpt-6-luna', provider: 'openai', effort: 'max' }, { model: 'gpt-6-luna', effort: 123 }, { model: 'gpt-6-luna', effort: 'max";bad' }]) {
      expect(() => effectiveModelChoice(input)).toThrow(/effort/i);
    }
  });
});
