/**
 * Restart self-heal for the recurring subconscious model drift.
 *
 * The bug (task u4IL): `subconsciousModelId` keeps reverting to a grok id
 * (e.g. grok-4.6) while `subconsciousProvider` stays codex. setSubconsciousProvider()
 * only clears a stranded override when the PROVIDER changes, so a stale concrete id
 * survives every restart (loadStateFromDB reloaded it verbatim) and gets re-broadcast
 * into the settings UI, which re-persists it and clobbers manual repairs.
 *
 * These tests pin the fix: on load, an inconsistent provider/model pair self-heals to
 * the provider default (''), while a *valid* concrete selection and any pair whose
 * catalog cannot be proven are left untouched (the landmine guard — never wipe a
 * legitimately-chosen model on a transient catalog miss).
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getSettingMock: any = jest.fn();
const setSettingMock: any = jest.fn(() => Promise.resolve());
const getFormValuesMock: any = jest.fn(() => Promise.resolve([]));

jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: {
    get: getSettingMock,
    set: setSettingMock,
  },
}));
jest.unstable_mockModule('../IntegrationService', () => ({
  getIntegrationService: () => ({
    getFormValues: getFormValuesMock,
  }),
}));
jest.unstable_mockModule('../../integrations/catalog', () => ({
  integrations: {},
}));

async function makeService(): Promise<any> {
  const { getModelProviderService } = await import('../ModelProviderService');
  const svc: any = getModelProviderService();
  // Reset the singleton's in-memory state between tests.
  svc.state = {
    primaryProvider:      'codex',
    secondaryProvider:    'codex',
    heartbeatProvider:    'codex',
    subconsciousProvider: 'codex',
    activeModelId:        '',
    modelMode:            'remote',
    secondaryModelId:     '',
    heartbeatModelId:     'codex',
    subconsciousModelId:  'codex',
  };
  return svc;
}

describe('ModelProviderService — subconscious drift self-heal', () => {
  beforeEach(() => {
    jest.restoreAllMocks(); // singleton service — undo prior spyOn(getModelsForProvider)
    getSettingMock.mockReset();
    setSettingMock.mockReset();
    setSettingMock.mockImplementation(() => Promise.resolve());
    getFormValuesMock.mockReset();
    getFormValuesMock.mockImplementation(() => Promise.resolve([]));
  });

  describe('modelIsStrandedForProvider (pure decision)', () => {
    it('flags a concrete id the provider does not offer as stranded', async() => {
      const svc = await makeService();
      // The exact reported pair: provider=codex offers codex/gpt-* but NOT grok-4.6.
      expect(svc.modelIsStrandedForProvider('grok-4.6', ['codex', 'gpt-5.3-codex', 'gpt-5-codex'])).toBe(true);
    });

    it('keeps a concrete id the provider DOES offer (valid selection)', async() => {
      const svc = await makeService();
      // Landmine case: provider=grok legitimately offers grok-4.6 — must NOT be wiped.
      expect(svc.modelIsStrandedForProvider('grok-4.6', ['grok-4.6', 'grok-3'])).toBe(false);
      // The 'auto' sentinel id equals the provider id and is in-list.
      expect(svc.modelIsStrandedForProvider('codex', ['codex', 'gpt-5.3-codex'])).toBe(false);
    });

    it('never flags provider-agnostic ids (empty / tier names)', async() => {
      const svc = await makeService();
      for (const id of ['', 'fast', 'balanced', 'powerful']) {
        expect(svc.modelIsStrandedForProvider(id, ['codex'])).toBe(false);
      }
    });

    it('fails safe when the provider catalog is unknown/empty (no proof of mismatch)', async() => {
      const svc = await makeService();
      // A dynamic provider whose catalog could not be loaded — resetting here would
      // clobber a legitimate choice, so we must keep it.
      expect(svc.modelIsStrandedForProvider('grok-4.6', [])).toBe(false);
    });
  });

  describe('reconcileSubconsciousModel', () => {
    it('resets the stranded codex/grok-4.6 pair to the provider default and persists it', async() => {
      const svc = await makeService();
      svc.state.subconsciousProvider = 'codex';
      svc.state.subconsciousModelId = 'grok-4.6';
      jest.spyOn(svc, 'getModelsForProvider').mockResolvedValue([
        { id: 'codex', name: 'Auto' }, { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
      ]);

      await svc.reconcileSubconsciousModel();

      expect(svc.state.subconsciousModelId).toBe('');
      expect(setSettingMock).toHaveBeenCalledWith('subconsciousModelId', '', 'string');
    });

    it('leaves a valid concrete selection untouched and does not write settings', async() => {
      const svc = await makeService();
      svc.state.subconsciousProvider = 'grok';
      svc.state.subconsciousModelId = 'grok-4.6';
      jest.spyOn(svc, 'getModelsForProvider').mockResolvedValue([
        { id: 'grok-4.6', name: 'Grok 4.6' }, { id: 'grok-3', name: 'Grok 3' },
      ]);

      await svc.reconcileSubconsciousModel();

      expect(svc.state.subconsciousModelId).toBe('grok-4.6');
      expect(setSettingMock).not.toHaveBeenCalled();
    });

    it('does not touch an agnostic id (no catalog lookup needed)', async() => {
      const svc = await makeService();
      svc.state.subconsciousProvider = 'codex';
      svc.state.subconsciousModelId = '';
      const spy = jest.spyOn(svc, 'getModelsForProvider');

      await svc.reconcileSubconsciousModel();

      expect(spy).not.toHaveBeenCalled();
      expect(setSettingMock).not.toHaveBeenCalled();
    });

    it('fails safe on a catalog fetch error (keeps the id, no write)', async() => {
      const svc = await makeService();
      svc.state.subconsciousProvider = 'grok';
      svc.state.subconsciousModelId = 'grok-4.6';
      jest.spyOn(svc, 'getModelsForProvider').mockRejectedValue(new Error('vault not ready'));

      await svc.reconcileSubconsciousModel();

      expect(svc.state.subconsciousModelId).toBe('grok-4.6');
      expect(setSettingMock).not.toHaveBeenCalled();
    });
  });

  describe('loadStateFromDB (end-to-end self-heal on restart)', () => {
    it('heals a stranded pair reloaded from the DB', async() => {
      const svc = await makeService();
      const db: Record<string, string> = {
        primaryProvider:      'codex',
        secondaryProvider:    'codex',
        heartbeatProvider:    'codex',
        subconsciousProvider: 'codex',
        secondaryModelId:     '',
        heartbeatModelId:     'codex',
        subconsciousModelId:  'grok-4.6', // the stranded id reloaded verbatim
        remoteModel:          '',
      };
      getSettingMock.mockImplementation((key: string, def: string) =>
        Promise.resolve(key in db ? db[key] : def));
      jest.spyOn(svc, 'getModelsForProvider').mockResolvedValue([
        { id: 'codex', name: 'Auto' }, { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
      ]);

      await svc.loadStateFromDB();

      expect(svc.state.subconsciousModelId).toBe('');
      expect(setSettingMock).toHaveBeenCalledWith('subconsciousModelId', '', 'string');
    });
  });
});
