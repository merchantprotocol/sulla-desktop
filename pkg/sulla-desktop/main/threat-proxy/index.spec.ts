// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { get: vi.fn(), set: vi.fn() } }));
vi.mock('@pkg/backend/threatProxyEgress', () => ({
  egressPolicyCommand: vi.fn(), installStagedFileCommand: vi.fn(), THREAT_PROXY_BLOCKLIST_PATH: '/blocklist',
  THREAT_PROXY_CONFIG_PATH: '/config', THREAT_PROXY_CONTAINER: 'sulla_threat_proxy',
}));
vi.mock('@pkg/utils/logging', () => ({ default: { 'threat-proxy': { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } }));
vi.mock('@pkg/utils/paths', () => ({ default: { altAppHome: '/tmp/sulla' } }));
vi.mock('@pkg/main/cloud/cloudEndpoints', () => ({ CLOUD_API_BASE: 'https://staging-workers.example.test' }));

import { renderConfigFile, URLHAUS_SOURCES, validateSettings, WATCHER_PROBE_SCRIPT } from './index';

describe('URLhaus source order', () => {
  it('downloads only from the configured Sulla Cloud route', () => {
    expect(URLHAUS_SOURCES).toEqual([
      'https://staging-workers.example.test/threat-intel/urlhaus.txt',
    ]);
  });
});


describe('Threat Proxy settings', () => {
  // risk: core business rule — invalid values could break proxy safety limits.
  it('rejects unsafe or out-of-range scan and retention limits', () => {
    expect(() => validateSettings({ trafficLogRetentionMinutes: 4 })).toThrow();
    expect(() => validateSettings({ scanMaxBytes: 0 })).toThrow();
    expect(() => validateSettings({ memoryPressurePercent: 96 })).toThrow();
  });

  // risk: data accuracy — all Desktop controls must reach the proxy config.
  it('passes new backend controls into the proxy config', () => {
    const config = JSON.parse(renderConfigFile({ enabled: true, allowlist: '', blockMode: 'block', injectionMode: 'warn', scanMaxBytes: 2097152, bufferBudgetMb: 48, scanBufferMaxBytes: 4194304, memoryPressurePercent: 60, trafficLogEnabled: true, trafficLogRetentionMinutes: 30 }, { safeBrowsingApiKey: '', virusTotalApiKey: '' }));
    expect(config).toMatchObject({ scanMaxBytes: 2097152, bufferBudgetMb: 48, scanBufferMaxBytes: 4194304, memoryPressurePercent: 60, trafficLogEnabled: true, trafficLogRetentionMinutes: 30 });
  });
});

describe('threat proxy watcher probe', () => {
  // risk: network protection — one guest probe must contain all health signals without container execs.
  it('gathers inspect, TCP, cgroup memory, CA and missing-agent state in one guest shell script', () => {
    expect(WATCHER_PROBE_SCRIPT).toContain('docker inspect');
    expect(WATCHER_PROBE_SCRIPT).toContain('/dev/tcp/127.0.0.1/8890');
    expect(WATCHER_PROBE_SCRIPT).toContain('memory.current');
    expect(WATCHER_PROBE_SCRIPT).toContain('sulla.threat-proxy.ca');
    expect(WATCHER_PROBE_SCRIPT).not.toContain('docker exec');
  });
});
