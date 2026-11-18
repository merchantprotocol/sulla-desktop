// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';

const windows = vi.hoisted(() => [] as Array<{ isDestroyed: () => boolean; webContents: { send: (...args: unknown[]) => void } }>);
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, BrowserWindow: { getAllWindows: () => windows } }));
vi.mock('@pkg/agent/services/IntegrationService', () => ({ getIntegrationService: () => ({ getFormValues: async () => [] }) }));
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { get: vi.fn(), set: vi.fn() } }));
vi.mock('@pkg/backend/threatProxyEgress', () => ({
  egressPolicyCommand: vi.fn((state: string) => ['egress-policy', state]), installStagedFileCommand: vi.fn((_staged: string, final: string) => ['install', final]), THREAT_PROXY_BLOCKLIST_PATH: '/blocklist', THREAT_PROXY_PUBLIC_DIR: '/public',
  THREAT_PROXY_CONFIG_PATH: '/config', THREAT_PROXY_CONTAINER: 'sulla_threat_proxy', THREAT_PROXY_TRAFFIC_LOG_PATH: '/traffic.jsonl',
}));
vi.mock('@pkg/utils/logging', () => ({ default: { 'threat-proxy': { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } }));
vi.mock('@pkg/utils/paths', () => ({ default: { altAppHome: '/tmp/sulla' } }));
vi.mock('@pkg/main/cloud/cloudEndpoints', () => ({ CLOUD_API_BASE: 'https://staging-workers.example.test' }));

import { clearGuest, clearTrafficLog, configureGuest, decideEgress, type EgressProbe, getTrafficLog, parseWatcherProbe, renderConfigFile, URLHAUS_SOURCES, validateSettings, WATCHER_PROBE_SCRIPT } from './index';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';

afterEach(() => { vi.useRealTimers(); windows.length = 0; });

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
    expect(readCommand).toContain('for f in "$1" "$1.1"');
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

// ── Watcher, apply throttling, serialization and settings: real module state, mocked guest executor ──

const HEALTHY = 'running|healthy|false|false|0|10|100|1|0|2';
const UNHEALTHY = 'running|unhealthy|false|false|0|10|100|1|0|2';
const TCP_FAIL = 'running|healthy|false|false|1|10|100|1|0|2';
const IDLE = 'absent||||0|0|0|0|0|0';

/** Fresh module instance per test so watcher counters and the effective policy never leak between tests. */
async function loadProxy() {
  vi.resetModules();
  return import('./index');
}

/** Real macrotask so queued guest work and the watcher's async check finish; only intervals and Date are fake. */
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 2)); };

function fakeGuest(opts: { probe?: () => string; policy?: (state: string) => Promise<void> } = {}) {
  const state = { probe: opts.probe ?? (() => HEALTHY) };
  const calls: string[] = [];
  const executor = {
    writeFile: vi.fn(async (file: string) => { calls.push(`write:${file}`); }),
    copyFileIn: vi.fn(async () => undefined),
    execCommand: vi.fn(async (_opts: unknown, ...args: string[]) => {
      if (args[3] === 'threat-proxy-watch') return state.probe();
      if (args[0] === 'egress-policy') { calls.push(`policy:${args[1]}`); await opts.policy?.(args[1]); return ''; }
      calls.push(args[0] === 'sh' ? `sh:${args[3]}` : `${args[0]}:${args[1]}`);
      return '';
    }),
  } as any;
  const count = (entry: string) => calls.filter(call => call === entry).length;
  return { executor, calls, state, count };
}

async function tick(times = 1) {
  for (let i = 0; i < times; i++) { vi.advanceTimersByTime(2_000); await settle(); }
}

/** configureGuest runs the first watcher check immediately; two more healthy ticks reach enforced. */
async function startEnforced(mod: Awaited<ReturnType<typeof loadProxy>>, guest: ReturnType<typeof fakeGuest>) {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  await mod.configureGuest(guest.executor);
  await settle();
  await tick(2);
  expect(mod.getStatus().state).toBe('running');
}

describe('threat proxy watcher', () => {
  // risk: network protection — a probe that throws must fail open, not leave agents redirected to a dead proxy.
  it('goes direct when the guest probe throws', async () => {
    const mod = await loadProxy();
    const guest = fakeGuest();
    await startEnforced(mod, guest);
    guest.state.probe = () => { throw new Error('exec failed'); };
    await tick();
    expect(mod.getStatus()).toMatchObject({ state: 'failing-open', failOpenTransitions24h: 1 });
    expect(mod.getStatus().reason).toMatch(/^health_check_error:exec failed/);
    expect(guest.calls.at(-1)).toBe('policy:direct');
    mod.clearGuest(guest.executor);
  });

  // risk: network protection — one missed TCP probe must not flap the policy; the second one goes direct.
  it('keeps enforcing after one failed probe and goes direct after the second', async () => {
    const mod = await loadProxy();
    const guest = fakeGuest();
    await startEnforced(mod, guest);
    guest.state.probe = () => TCP_FAIL;
    await tick();
    expect(mod.getStatus().state).toBe('running');
    expect(guest.count('policy:direct')).toBe(1); // only the startup sync
    await tick();
    expect(mod.getStatus()).toMatchObject({ state: 'failing-open', reason: 'probe_failed_twice' });
    expect(guest.count('policy:direct')).toBe(2);
    mod.clearGuest(guest.executor);
  });

  // risk: data accuracy — an idle runtime with the proxy stopped is standby and must not inflate the fail-open count.
  it('reports standby and records no fail-open when the proxy stops with zero agents', async () => {
    const mod = await loadProxy();
    const guest = fakeGuest();
    await startEnforced(mod, guest);
    guest.state.probe = () => IDLE;
    await tick();
    expect(mod.getStatus()).toMatchObject({ state: 'standby', reason: 'idle', failOpenTransitions24h: 0 });
    expect(guest.calls.at(-1)).toBe('policy:direct');
    mod.clearGuest(guest.executor);
  });

  // risk: data accuracy — the renderer must hear about real transitions only, not every 2 s tick.
  it('broadcasts status-changed on transitions only', async () => {
    const send = vi.fn();
    windows.push({ isDestroyed: () => false, webContents: { send } });
    const mod = await loadProxy();
    const guest = fakeGuest();
    await startEnforced(mod, guest);
    const sent = () => send.mock.calls.filter(call => call[0] === 'threat-proxy:status-changed').length;
    expect(sent()).toBe(2); // off -> direct (pending), direct -> enforced
    expect(send.mock.calls.at(-1)?.[1]).toMatchObject({ state: 'running' });
    await tick(3);
    expect(sent()).toBe(2);
    guest.state.probe = () => UNHEALTHY;
    await tick();
    expect(sent()).toBe(3);
    expect(send.mock.calls.at(-1)?.[1]).toMatchObject({ state: 'failing-open' });
    await tick(2);
    expect(sent()).toBe(3);
    mod.clearGuest(guest.executor);
  });
});

describe('threat proxy apply throttling', () => {
  // risk: performance/availability — rewriting iptables every 2 s churns the guest firewall; apply only on change.
  it('applies iptables only when the target policy changes', async () => {
    const mod = await loadProxy();
    const guest = fakeGuest();
    await startEnforced(mod, guest);
    expect(guest.count('policy:enforced')).toBe(1);
    await tick(5);
    expect(guest.count('policy:enforced')).toBe(1);
    guest.state.probe = () => UNHEALTHY;
    await tick(3);
    expect(guest.count('policy:direct')).toBe(2); // startup sync + one fail-open
    mod.clearGuest(guest.executor);
  });

  // risk: network policy — a firewall flushed behind our back must be repaired by the 60 s reconcile.
  it('reapplies the unchanged policy after the 60 s reconcile interval', async () => {
    const mod = await loadProxy();
    const guest = fakeGuest();
    await startEnforced(mod, guest);
    await tick(25); // 50 s
    expect(guest.count('policy:enforced')).toBe(1);
    await tick(6); // 62 s
    expect(guest.count('policy:enforced')).toBe(2);
    mod.clearGuest(guest.executor);
  });

  // risk: network protection — a failed apply must leave the policy treated as direct and be retried on the next tick.
  it('treats a failed apply as direct and retries it on the next tick', async () => {
    let failures = 2;
    const mod = await loadProxy();
    const guest = fakeGuest({ policy: async state => { if (state === 'direct' && guest.count('policy:direct') > 1 && failures > 0) { failures--; throw new Error('iptables-restore failed'); } } });
    await startEnforced(mod, guest);
    guest.state.probe = () => UNHEALTHY;
    await tick();
    expect(guest.count('policy:direct')).toBe(3); // startup sync + failed apply + failed in-tick retry
    expect(mod.getStatus().state).toBe('failing-open');
    await tick();
    expect(guest.count('policy:direct')).toBe(4); // retried, not throttled
    await tick();
    expect(guest.count('policy:direct')).toBe(4); // succeeded, now throttled
    mod.clearGuest(guest.executor);
  });
});

describe('threat proxy guest serialization', () => {
  // risk: network policy — a settings sync and a watcher apply must never interleave their guest commands.
  it('runs a settings sync and a concurrent watcher apply strictly in order', async () => {
    const mod = await loadProxy();
    const guest = fakeGuest({ probe: () => HEALTHY });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    await mod.configureGuest(guest.executor);
    await settle();
    let release!: () => void;
    guest.executor.writeFile.mockImplementationOnce(async (file: string) => { guest.calls.push(`write:${file}`); await new Promise<void>(resolve => { release = resolve; }); });
    const before = guest.calls.length;
    const sync = mod.setSettings({ allowlist: 'example.test' });
    await vi.waitFor(() => expect(guest.executor.writeFile).toHaveBeenCalledTimes(2));
    const apply = mod.applyEgressPolicy(guest.executor, 'enforced');
    await settle();
    const since = () => guest.calls.slice(before).filter(call => call !== 'install:/blocklist');
    // Staged path is dirname(THREAT_PROXY_CONFIG_PATH) + '/.proxy.json.new'; the mock config path is '/config'.
    expect(since()).toEqual(['write://.proxy.json.new']);
    release();
    await Promise.all([sync, apply]);
    expect(since()).toEqual(['write://.proxy.json.new', 'install:/config', 'policy:enforced']);
    mod.clearGuest(guest.executor);
  });
});

describe('threat proxy settings sync', () => {
  // risk: network protection — saving settings while enforced and healthy must not drop agents to direct.
  it('keeps enforced egress when settings sync while the proxy is healthy', async () => {
    const send = vi.fn();
    windows.push({ isDestroyed: () => false, webContents: { send } });
    const mod = await loadProxy();
    const guest = fakeGuest();
    await startEnforced(mod, guest);
    const directBefore = guest.count('policy:direct');
    const sendsBefore = send.mock.calls.length;
    await mod.setSettings({ allowlist: 'example.test', blockMode: 'warn' });
    await tick();
    expect(mod.getStatus()).toMatchObject({ state: 'running', reason: 'healthy' });
    expect(guest.count('policy:direct')).toBe(directBefore);
    expect(send.mock.calls.length).toBe(sendsBefore);
    mod.clearGuest(guest.executor);
  });

  // risk: privacy — turning the traffic log off must erase what was already recorded.
  it('clears the traffic log when trafficLogEnabled is turned off', async () => {
    const mod = await loadProxy();
    const guest = fakeGuest();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    await mod.configureGuest(guest.executor);
    await mod.setSettings({ trafficLogEnabled: false });
    expect(guest.count('sh:clear-traffic-log')).toBe(1);
    mod.clearGuest(guest.executor);
  });
});

describe('threat proxy traffic log read bound', () => {
  // risk: performance — reading the log must never pull more than 4 MiB out of the guest into the main process.
  it('reads at most 4 MiB across the active and rotated files', async () => {
    const mod = await loadProxy();
    const guest = fakeGuest({ probe: () => IDLE });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    await mod.configureGuest(guest.executor);
    await mod.getTrafficLog({});
    const call = guest.executor.execCommand.mock.calls.find((c: any[]) => c[4] === 'traffic-log');
    const script = call?.[3] as string;
    const perFile = [...script.matchAll(/tail -c (\d+)/g)].map(m => Number(m[1]));
    const files = (script.match(/for f in ((?:"[^"]+"\s*)+);/)?.[1].match(/"[^"]+"/g) ?? []).length;
    expect(perFile).toHaveLength(1);
    expect(files).toBe(2);
    expect(perFile[0] * files).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(script).not.toMatch(/\bcat\b/);
    mod.clearGuest(guest.executor);
  });
});
