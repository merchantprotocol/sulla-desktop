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

import { clearGuest, clearTrafficLog, configureGuest, decideEgress, type EgressProbe, getTrafficLog, parseWatcherProbe, renderConfigFile, URLHAUS_SOURCES, validateSettings, WATCHER_PROBE_SCRIPT } from './index';
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

describe('egress decision', () => {
  const healthy: EgressProbe = { state: 'running', health: 'healthy', oomKilled: false, restarting: false, tcpOk: true, memCurrent: 10, memMax: 100, caPresent: true, agentsWithoutCa: false, runningAgents: 2 };
  const fresh = { healthyTicks: 0, failedProbes: 0 };

  // risk: network protection — an unhealthy proxy must fail open on the first tick, not after a delay.
  it('goes direct immediately when the proxy is unhealthy', () => {
    const decision = decideEgress({ ...healthy, health: 'unhealthy' }, { healthyTicks: 2, failedProbes: 0 });
    expect(decision).toMatchObject({ policy: 'direct', status: 'failing-open', countsAsFailOpen: true, next: fresh });
    expect(decision.reason).toBe('proxy_running_unhealthy_oom_false_restarting_false');
  });

  // risk: network protection — an OOM-killed proxy has lost its enforcement state and must fail open.
  it('goes direct when the proxy was OOM-killed', () => {
    const decision = decideEgress({ ...healthy, oomKilled: true }, fresh);
    expect(decision).toMatchObject({ policy: 'direct', countsAsFailOpen: true });
    expect(decision.reason).toBe('proxy_running_healthy_oom_true_restarting_false');
  });

  // risk: network protection — a restarting proxy is not serving traffic and must fail open.
  it('goes direct when the proxy is restarting', () => {
    const decision = decideEgress({ ...healthy, restarting: true }, fresh);
    expect(decision).toMatchObject({ policy: 'direct', countsAsFailOpen: true });
    expect(decision.reason).toBe('proxy_running_healthy_oom_false_restarting_true');
  });

  // risk: network protection — one missed TCP probe is noise, two in a row means the proxy is gone.
  it('holds the policy after one probe failure and goes direct after the second', () => {
    const first = decideEgress({ ...healthy, tcpOk: false }, fresh);
    expect(first).toMatchObject({ policy: null, status: 'hold', next: { healthyTicks: 0, failedProbes: 1 } });
    const second = decideEgress({ ...healthy, tcpOk: false }, first.next);
    expect(second).toMatchObject({ policy: 'direct', reason: 'probe_failed_twice', countsAsFailOpen: true, next: { healthyTicks: 0, failedProbes: 2 } });
  });

  // risk: network protection — memory at 90% of the cgroup limit means the proxy is about to be OOM-killed.
  it('goes direct at 90% memory and not below it', () => {
    expect(decideEgress({ ...healthy, memCurrent: 90, memMax: 100 }, fresh)).toMatchObject({ policy: 'direct', reason: 'memory_pressure' });
    expect(decideEgress({ ...healthy, memCurrent: 89, memMax: 100 }, fresh)).toMatchObject({ policy: null, reason: 'healthy_pending' });
  });

  // risk: network protection — enforcement must not start on a single lucky probe, and never without the CA bundle.
  it('needs three consecutive healthy ticks and a CA bundle before enforcing', () => {
    const t1 = decideEgress(healthy, fresh);
    const t2 = decideEgress(healthy, t1.next);
    const t3 = decideEgress(healthy, t2.next);
    expect(t1.policy).toBeNull();
    expect(t2.policy).toBeNull();
    expect(t3).toMatchObject({ policy: 'enforced', status: 'running', reason: 'healthy', countsAsFailOpen: false });
    expect(decideEgress({ ...healthy, caPresent: false }, { healthyTicks: 2, failedProbes: 0 })).toMatchObject({ policy: 'direct', reason: 'ca_bundle_missing' });
  });

  // risk: privacy/security — an agent without the proxy CA cannot trust TLS through the proxy, so the whole policy goes direct.
  it('goes direct when a running agent has no proxy CA', () => {
    const decision = decideEgress({ ...healthy, agentsWithoutCa: true }, { healthyTicks: 2, failedProbes: 1 });
    expect(decision).toMatchObject({ policy: 'direct', reason: 'agent_without_ca', countsAsFailOpen: true, next: { healthyTicks: 0, failedProbes: 1 } });
  });

  // risk: availability — with no agents running, a stopped proxy is standby and must not be counted as a fail-open incident.
  it('reports standby without a fail-open count when the proxy is absent and no agents run', () => {
    const probe = parseWatcherProbe('absent||||0|0|0|0|0|0');
    const decision = decideEgress(probe, fresh);
    expect(decision).toMatchObject({ policy: 'direct', status: 'standby', reason: 'idle', countsAsFailOpen: false, next: fresh });
  });

  // risk: network protection — garbage or empty probe output must fail open, never be treated as healthy.
  it('goes direct when the probe output cannot be parsed', () => {
    expect(parseWatcherProbe('garbage')).toBeNull();
    expect(parseWatcherProbe('')).toBeNull();
    expect(parseWatcherProbe('running|healthy|false|false|x|1|2|1|0|2')).toBeNull();
    expect(decideEgress(parseWatcherProbe('garbage'), { healthyTicks: 2, failedProbes: 1 })).toMatchObject({ policy: 'direct', reason: 'probe_parse_error', countsAsFailOpen: true });
  });

  // risk: data accuracy — the real guest probe line must map onto the typed signals the decision reads.
  it('parses a healthy guest probe line into typed signals', () => {
    expect(parseWatcherProbe('running|healthy|false|false|0|1000|2000|1|0|2')).toEqual({
      state: 'running', health: 'healthy', oomKilled: false, restarting: false, tcpOk: true,
      memCurrent: 1000, memMax: 2000, caPresent: true, agentsWithoutCa: false, runningAgents: 2,
    });
  });
});
