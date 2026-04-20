/** @jest-environment node */

import os from 'os';

import { jest } from '@jest/globals';

import mockModules from '@pkg/utils/testUtils/mockModules';

const mockSullaSettingsModel = {
  SullaSettingsModel: {
    get: jest.fn<() => Promise<any>>(),
    set: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  },
};

const mockVersion = { getProductionVersion: jest.fn<() => string | null>().mockReturnValue('1.2.3') };

mockModules({
  '@pkg/agent/database/models/SullaSettingsModel': mockSullaSettingsModel,
  '@pkg/utils/version':                            mockVersion,
  '@pkg/utils/logging':                            undefined,
});

const { getDesktopDeviceMetadata, getDesktopDeviceId } = await import('@pkg/main/deviceIdentity');

const { SullaSettingsModel } = mockSullaSettingsModel;

describe('getDesktopDeviceId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns an existing device id from the DB without writing', async() => {
    SullaSettingsModel.get.mockResolvedValue('existing-id-123');
    const id = await getDesktopDeviceId();
    expect(id).toBe('existing-id-123');
    expect(SullaSettingsModel.set).not.toHaveBeenCalled();
  });

  it('generates and persists a new UUID when the DB has no id', async() => {
    SullaSettingsModel.get.mockResolvedValue('');
    const id = await getDesktopDeviceId();
    // UUID v4 format
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(SullaSettingsModel.set).toHaveBeenCalledWith('sullaCloudDeviceId', id, 'string');
  });

  it('returns the same id across two calls when DB is consistent', async() => {
    SullaSettingsModel.get.mockResolvedValue('stable-id');
    const [a, b] = await Promise.all([getDesktopDeviceId(), getDesktopDeviceId()]);
    expect(a).toBe('stable-id');
    expect(b).toBe('stable-id');
  });
});

describe('getDesktopDeviceMetadata', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    SullaSettingsModel.get.mockResolvedValue('device-uuid');
  });

  it('returns deviceType = desktop', async() => {
    const meta = await getDesktopDeviceMetadata();
    expect(meta.deviceType).toBe('desktop');
  });

  it('normalizes platform to macos / windows / linux', async() => {
    const meta = await getDesktopDeviceMetadata();
    expect(['macos', 'windows', 'linux']).toContain(meta.platform);
  });

  it('includes hostname from os.hostname()', async() => {
    const meta = await getDesktopDeviceMetadata();
    expect(meta.hostname).toBe(os.hostname());
  });

  it('exposes appVersion from getProductionVersion()', async() => {
    const meta = await getDesktopDeviceMetadata();
    expect(meta.appVersion).toBe('1.2.3');
  });

  it('name falls back to hostname when available', async() => {
    const meta = await getDesktopDeviceMetadata();
    expect(meta.name).toBeTruthy();
  });
});
