import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { get: vi.fn(), set: vi.fn() } }));
vi.mock('@pkg/backend/threatProxyEgress', () => ({
  egressPolicyCommand: vi.fn(), installStagedFileCommand: vi.fn(), THREAT_PROXY_BLOCKLIST_PATH: '/blocklist',
  THREAT_PROXY_CONFIG_PATH: '/config', THREAT_PROXY_CONTAINER: 'sulla_threat_proxy',
}));
vi.mock('@pkg/utils/logging', () => ({ default: { 'threat-proxy': { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } }));
vi.mock('@pkg/utils/paths', () => ({ default: { altAppHome: '/tmp/sulla' } }));
vi.mock('@pkg/main/cloud/cloudEndpoints', () => ({ CLOUD_API_BASE: 'https://staging-workers.example.test' }));

import { URLHAUS_SOURCES } from './index';

describe('URLhaus source order', () => {
  it('downloads only from the configured Sulla Cloud route', () => {
    expect(URLHAUS_SOURCES).toEqual([
      'https://staging-workers.example.test/threat-intel/urlhaus.txt',
    ]);
  });
});
