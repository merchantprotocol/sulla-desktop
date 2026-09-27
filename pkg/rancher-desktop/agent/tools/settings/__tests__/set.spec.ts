/** @jest-environment node */
import { jest } from '@jest/globals';

import mockModules from '@pkg/utils/testUtils/mockModules';

const set = jest.fn(() => Promise.resolve(undefined));
mockModules({
  '@pkg/agent/database/models/SullaSettingsModel': { SullaSettingsModel: { set, get: jest.fn() } },
});

const { SettingsSetWorker } = await import('@pkg/agent/tools/settings/set');

test('agents cannot change Sulla Cloud sync or remote-access settings', async() => {
  const tool = new SettingsSetWorker() as any;
  for (const property of ['cloudSyncVault', 'cloudRemoteAccess', 'cloudSyncConversations', 'pairedMobileUserId']) {
    const res = await tool._validatedCall({ property, value: true });
    expect(res.successBoolean).toBe(false);
    expect(res.responseString).toMatch(/Only the owner/);
  }
  expect(set).not.toHaveBeenCalled();
});

test('ordinary settings still write through', async() => {
  const tool = new SettingsSetWorker() as any;
  const res = await tool._validatedCall({ property: 'heartbeatEnabled', value: true, cast: 'boolean' });
  expect(res.successBoolean).toBe(true);
  expect(set).toHaveBeenCalledWith('heartbeatEnabled', true, 'boolean');
});
