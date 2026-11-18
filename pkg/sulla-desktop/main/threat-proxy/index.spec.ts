// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { get: vi.fn(), set: vi.fn() } }));
vi.mock('@pkg/backend/threatProxyEgress', () => ({
  egressPolicyCommand: vi.fn(), installStagedFileCommand: vi.fn(), THREAT_PROXY_BLOCKLIST_PATH: '/blocklist',
  THREAT_PROXY_CONFIG_PATH: '/config', THREAT_PROXY_CONTAINER: 'sulla_threat_proxy', THREAT_PROXY_TRAFFIC_LOG_PATH: '/traffic.jsonl',
}));
vi.mock('@pkg/utils/logging', () => ({ default: { 'threat-proxy': { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } }));
vi.mock('@pkg/utils/paths', () => ({ default: { altAppHome: '/tmp/sulla' } }));
vi.mock('@pkg/main/cloud/cloudEndpoints', () => ({ CLOUD_API_BASE: 'https://staging-workers.example.test' }));

import { clearGuest, clearTrafficLog, configureGuest, getTrafficLog, renderConfigFile, URLHAUS_SOURCES, validateSettings, WATCHER_PROBE_SCRIPT } from './index';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';

afterEach(() => vi.useRealTimers());

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

describe('threat proxy traffic log', () => {
  // risk: privacy/data retention — stale rows and query values must not be exposed.
  it('filters retention, verdict, and host/path search while redacting query values', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T12:00:00Z'));
    vi.mocked(SullaSettingsModel.get).mockImplementation(async (_key: string, fallback: any) => _key.endsWith('trafficLogRetentionMinutes') ? 5 : fallback);
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 6 * 60_000).toISOString();
    const executor = {
      writeFile: vi.fn().mockResolvedValue(undefined), copyFileIn: vi.fn().mockResolvedValue(undefined),
      execCommand: vi.fn().mockImplementation(async (_opts: any, ...args: string[]) => args[0] === 'sh' && args[3] === 'traffic-log'
        ? `${JSON.stringify({ ts: old, verdict: 'allow', host: 'old.example', path: '/' })}\n${JSON.stringify({ ts: now, verdict: 'block', host: 'example.test', path: '/search?q=private&x=2' })}\n${JSON.stringify({ ts: now, verdict: 'allow', host: 'other.test', path: '/x' })}` : ''),
    } as any;
    await configureGuest(executor);
    const result = await getTrafficLog({ verdict: 'block', search: 'example.test' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ host: 'example.test', path: '/search?q=…&x=…' });
    const readCommand = executor.execCommand.mock.calls.find((call: any[]) => call[4] === 'traffic-log')?.[3] as string;
    expect(readCommand).toContain('tail -c 2097152');
    expect((readCommand.match(/tail -c 2097152/g) ?? [])).toHaveLength(2);
    clearGuest(executor);
  });

  // risk: privacy — clear must truncate both active and rotated guest logs.
  it('clears active and rotated files', async () => {
    const executor = { writeFile: vi.fn().mockResolvedValue(undefined), copyFileIn: vi.fn().mockResolvedValue(undefined), execCommand: vi.fn().mockResolvedValue('') } as any;
    await configureGuest(executor);
    await clearTrafficLog();
    expect(executor.execCommand.mock.calls.some((call: any[]) => call.slice(1).join(' ').includes(': > "$1"; : > "$1.1"'))).toBe(true);
    clearGuest(executor);
  });
});
