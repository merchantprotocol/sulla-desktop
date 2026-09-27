/** @jest-environment node */
import { jest } from '@jest/globals';

import mockModules from '@pkg/utils/testUtils/mockModules';

const store = new Map<string, unknown>();
mockModules({
  '@pkg/agent/database/models/SullaSettingsModel': {
    SullaSettingsModel: {
      get: jest.fn((k: string, d: unknown) => Promise.resolve(store.has(k) ? store.get(k) : d)),
      set: jest.fn((k: string, v: unknown) => { store.set(k, v); return Promise.resolve() }),
    },
  },
});

const { getCloudPreferences, setCloudPreferences, isProtectedSetting, onCloudPreferencesChanged } = await import('@pkg/main/cloud/cloudSettings');

beforeEach(() => store.clear());

test('new installs: every sync is off, remote access on (nothing is approved yet)', async() => {
  expect(await getCloudPreferences()).toEqual({ conversations: false, vault: false, projects: false, remoteAccess: true });
});

test('installs already syncing chat keep conversations on after the update', async() => {
  store.set('claudeSyncLastSeq', '173512');
  expect(await getCloudPreferences()).toEqual({ conversations: true, vault: false, projects: false, remoteAccess: true });
});

test('migration runs once; later owner choices stick', async() => {
  store.set('claudeSyncLastSeq', '5');
  await getCloudPreferences();
  await setCloudPreferences({ conversations: false });
  expect((await getCloudPreferences()).conversations).toBe(false);
});

test('only real booleans change a preference, and listeners hear exactly what changed', async() => {
  const seen: string[][] = [];
  const off = onCloudPreferencesChanged((_p, changed) => seen.push(changed));
  await setCloudPreferences({ vault: 'true' as any, projects: true, evil: true } as any);
  off();
  expect(await getCloudPreferences()).toMatchObject({ vault: false, projects: true });
  expect(seen).toEqual([['projects']]);
});

test('cloud security settings are protected from the agent settings tool', () => {
  for (const k of ['cloudSyncVault', 'cloudSyncConversations', 'cloudRemoteAccess', 'cloudSyncPreferencesInitialized', 'pairedMobileUserId', 'secureChannelAnything']) {
    expect(isProtectedSetting(k)).toBe(true);
  }
  expect(isProtectedSetting('heartbeatEnabled')).toBe(false);
});
