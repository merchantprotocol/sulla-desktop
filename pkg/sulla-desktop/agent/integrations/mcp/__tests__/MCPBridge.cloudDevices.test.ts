// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, jest } from '@jest/globals';

import type { CloudDeviceChannel } from '../CloudDeviceTransport';

jest.unstable_mockModule('../MCPClient', () => ({ MCPClient: class {} }));
jest.unstable_mockModule('@pkg/main/cloud/cloudFetch', () => ({ cloudRequest: jest.fn() }));
jest.unstable_mockModule('@pkg/main/cloud/deviceKey', () => ({ signDeviceMessageExact: jest.fn() }));
jest.unstable_mockModule('@pkg/main/deviceIdentity', () => ({ getDesktopDeviceId: jest.fn() }));
jest.unstable_mockModule('@pkg/main/sullaCloudAuth', () => ({ getCurrentUserId: jest.fn() }));

const { MCPBridge } = await import('../MCPBridge');

describe('MCPBridge Cloud app reconciliation', () => {
  it('adds the manifest account and removes it when the device disappears', async() => {
    let present = true;
    const channel: CloudDeviceChannel = {
      listDevices: async() => present ? [{ id: 'app-1', deviceType: 'app', appSlug: 'ai-visibility-lab', name: 'AI Visibility Lab', online: false }] : [],
      getManifest: async() => ({ appSlug: 'ai-visibility-lab', tools: [{ name: 'list_projects' }] }),
      identity:    async() => ({ userId: 'user-1', deviceId: 'desktop-1' }),
      sign:        (_parts, ts) => ({ ts, signature: 'signed' }),
      rpc:         jest.fn(async() => { throw new Error('This Cloud app device is offline. Start it and try again.') }),
    };
    const bridge = new MCPBridge(channel);

    await bridge.refreshCloudDevices();
    expect(bridge.getToolsForAccount('ai-visibility-lab').map(tool => tool.name)).toEqual(['list_projects']);

    present = false;
    await bridge.refreshCloudDevices();
    expect(bridge.getToolsForAccount('ai-visibility-lab')).toEqual([]);
  });
});
