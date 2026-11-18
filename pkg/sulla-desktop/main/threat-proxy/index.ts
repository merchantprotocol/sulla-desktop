// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * @module threat-proxy
 *
 * # Sulla Threat Proxy — Electron-side lifecycle
 *
 * The proxy itself is the `sulla_threat_proxy` container on the Sulla runtime
 * (services/sulla-threat-proxy: mitmdump in transparent mode). The guest
 * firewall redirects agent web traffic to it; see
 * backend/threatProxyEgress.ts for the packet path. This module is the
 * host-side glue:
 *
 *   - Persists user-facing settings via SullaSettingsModel (API keys stay in
 *     the vault and are read through IntegrationService).
 *   - Delivers config + the URLhaus blocklist into the proxy's state directory
 *     on the guest data disk; the proxy re-reads them without a restart.
 *   - Applies or removes the egress redirect when the user toggles `enabled`.
 *   - Refreshes the URLhaus blocklist on a timer from the host.
 */

import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import readline from 'readline';
import { URL } from 'url';
import { ThreatProxyDailyCounters, type ThreatDailyCounters } from '../security/ThreatProxyDailyCounters';

import { BrowserWindow, ipcMain } from 'electron';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import type { VMExecutor } from '@pkg/backend/backend';
import {
  egressPolicyCommand, installStagedFileCommand, THREAT_PROXY_BLOCKLIST_PATH, THREAT_PROXY_CONFIG_PATH, THREAT_PROXY_CONTAINER, THREAT_PROXY_PUBLIC_DIR, THREAT_PROXY_TRAFFIC_LOG_PATH, THREAT_PROXY_STATE_DIR, type EgressPolicyState,
} from '@pkg/backend/threatProxyEgress';
import Logging from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';
import { CLOUD_API_BASE } from '@pkg/main/cloud/cloudEndpoints';

const console = Logging['threat-proxy'];

/**
 * Non-secret settings keys persisted in SullaSettingsModel. API keys live in the
 * password vault via the IntegrationService (integrations: 'google-safe-browsing',
 * 'virustotal') and are read through getApiKeys() below — never stored here.
 */
export const SETTINGS_KEYS = {
  enabled:            'threatProxy.enabled',
  allowlist:          'threatProxy.allowlist',
  blockMode:          'threatProxy.blockMode',
  injectionMode:      'threatProxy.injectionMode',
  scanMaxBytes:        'threatProxy.scanMaxBytes',
  bufferBudgetMb:      'threatProxy.bufferBudgetMb',
  scanBufferMaxBytes:  'threatProxy.scanBufferMaxBytes',
  memoryPressurePercent: 'threatProxy.memoryPressurePercent',
  trafficLogEnabled:   'threatProxy.trafficLogEnabled',
  trafficLogRetentionMinutes: 'threatProxy.trafficLogRetentionMinutes',
  blocklistUpdatedAt: 'threatProxy.blocklistUpdatedAt',
} as const;

/** Integration IDs whose `api_key` field feeds the threat proxy. */
export const INTEGRATION_IDS = {
  safeBrowsing: 'google-safe-browsing',
  virusTotal:   'virustotal',
} as const;

/** Non-secret runtime knobs. API keys are fetched separately via getApiKeys(). */
export interface ThreatProxySettings {
  enabled:       boolean;
  allowlist:     string;      // comma-separated domains
  blockMode:     'block' | 'warn' | 'off';
  injectionMode: 'warn' | 'redact' | 'off';
  scanMaxBytes: number;
  bufferBudgetMb: number;
  scanBufferMaxBytes: number;
  memoryPressurePercent: number;
  trafficLogEnabled: boolean;
  trafficLogRetentionMinutes: number;
}

/** Sensitive credentials sourced from the IntegrationService / vault. */
export interface ThreatProxyCredentials {
  safeBrowsingApiKey: string;
  virusTotalApiKey:   string;
}

const DEFAULT_SETTINGS: ThreatProxySettings = {
  enabled:       true,
  allowlist:     '',
  blockMode:     'block',
  injectionMode: 'warn',
  scanMaxBytes: 2_097_152, bufferBudgetMb: 48, scanBufferMaxBytes: 4_194_304,
  memoryPressurePercent: 60, trafficLogEnabled: false, trafficLogRetentionMinutes: 30,
};

/**
 * Where installs download the URLhaus host blocklist: Sulla Cloud only. Cloud
 * refreshes its copy daily, replaces it only with a verified download and keeps
 * one backup. abuse.ch retired its anonymous feeds (HTTP 410, seen 2026-11-16),
 * so Cloud owns the upstream choice. When Cloud is unreachable the proxy keeps
 * its last delivered list, or the default list bundled in the image.
 */
export const URLHAUS_SOURCES = [
  `${ CLOUD_API_BASE }/threat-intel/urlhaus.txt`,
];
const URLHAUS_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
// Hard cap so a pathological server or redirect loop can't blow the Electron
// main-process heap. URLhaus's hostfile is normally <50MB; anything over this
// is almost certainly wrong. If we hit it we abort the download and keep the
// prior file, failing open rather than OOM'ing the app.
const URLHAUS_MAX_BYTES = 200 * 1024 * 1024; // 200MB

/** Host-side copy of the blocklist; syncGuest() copies it into the guest. */
function getBlocklistHostPath(): string {
  return path.join(paths.altAppHome, 'threat-proxy', 'blocklist', 'urlhaus.txt');
}

const INJECTION_SCAN_CONTENT_TYPES = ['text/html', 'text/plain', 'application/json', 'text/markdown', 'text/xml', 'application/xml'];

let initialized = false;
let refreshTimer: NodeJS.Timeout | null = null;
/** The running Sulla runtime, set by the backend once the guest is up. */
let guest: VMExecutor | undefined;
let guestSync: Promise<void> = Promise.resolve();
let watcher: NodeJS.Timeout | null = null;
let healthCheck: Promise<void> | undefined;
let healthyProbes = 0;
let failedProbes = 0;
let effectivePolicy: EgressPolicyState = 'off';
let statusSince = new Date().toISOString();
let lastTransition = statusSince;
let statusReason = 'initializing';
const failOpenTransitions: number[] = [];

// ── Settings helpers ─────────────────────────────────────────────────

async function readSettings(): Promise<ThreatProxySettings> {
  const get = async <T>(key: string, fallback: T): Promise<T> => {
    try {
      const value = await SullaSettingsModel.get(key, fallback as any);

      return (value === undefined || value === null ? fallback : value) as T;
    } catch (err) {
      console.warn(`readSettings: failed to read ${ key }`, err);

      return fallback;
    }
  };

  return {
    enabled:       await get(SETTINGS_KEYS.enabled, DEFAULT_SETTINGS.enabled),
    allowlist:     await get(SETTINGS_KEYS.allowlist, DEFAULT_SETTINGS.allowlist),
    blockMode:     await get(SETTINGS_KEYS.blockMode, DEFAULT_SETTINGS.blockMode),
    injectionMode: await get(SETTINGS_KEYS.injectionMode, DEFAULT_SETTINGS.injectionMode),
    scanMaxBytes: await get(SETTINGS_KEYS.scanMaxBytes, DEFAULT_SETTINGS.scanMaxBytes),
    bufferBudgetMb: await get(SETTINGS_KEYS.bufferBudgetMb, DEFAULT_SETTINGS.bufferBudgetMb),
    scanBufferMaxBytes: await get(SETTINGS_KEYS.scanBufferMaxBytes, DEFAULT_SETTINGS.scanBufferMaxBytes),
    memoryPressurePercent: await get(SETTINGS_KEYS.memoryPressurePercent, DEFAULT_SETTINGS.memoryPressurePercent),
    trafficLogEnabled: await get(SETTINGS_KEYS.trafficLogEnabled, DEFAULT_SETTINGS.trafficLogEnabled),
    trafficLogRetentionMinutes: await get(SETTINGS_KEYS.trafficLogRetentionMinutes, DEFAULT_SETTINGS.trafficLogRetentionMinutes),
  };
}

export function validateSettings(partial: Partial<ThreatProxySettings>): void {
  const ranges: Record<string, [number, number]> = {
    scanMaxBytes: [1, 16_777_216], bufferBudgetMb: [1, 512], scanBufferMaxBytes: [1, 67_108_864],
    memoryPressurePercent: [10, 95], trafficLogRetentionMinutes: [5, 1440],
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const value = (partial as any)[key];
    if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) throw new Error(`${key} must be an integer from ${min} to ${max}`);
  }
  if ((partial.enabled !== undefined && typeof partial.enabled !== 'boolean') || (partial.trafficLogEnabled !== undefined && typeof partial.trafficLogEnabled !== 'boolean')) throw new Error('boolean threat proxy setting has invalid value');
  if (partial.blockMode !== undefined && !['block','warn','off'].includes(partial.blockMode)) throw new Error('blockMode is invalid');
  if (partial.injectionMode !== undefined && !['warn','redact','off'].includes(partial.injectionMode)) throw new Error('injectionMode is invalid');
  if (partial.allowlist !== undefined && typeof partial.allowlist !== 'string') throw new Error('allowlist must be a string');
}

async function writeSetting(key: string, value: unknown, type: 'string' | 'boolean' | 'number' = 'string'): Promise<void> {
  await SullaSettingsModel.set(key, value as any, type);
}

export async function getSettings(): Promise<ThreatProxySettings> {
  return readSettings();
}

export async function setSettings(partial: Partial<ThreatProxySettings>): Promise<ThreatProxySettings> {
  validateSettings(partial);
  if (partial.enabled !== undefined) {
    await writeSetting(SETTINGS_KEYS.enabled, partial.enabled, 'boolean');
  }
  if (partial.allowlist !== undefined) {
    await writeSetting(SETTINGS_KEYS.allowlist, partial.allowlist);
  }
  if (partial.blockMode !== undefined) {
    await writeSetting(SETTINGS_KEYS.blockMode, partial.blockMode);
  }
  if (partial.injectionMode !== undefined) { await writeSetting(SETTINGS_KEYS.injectionMode, partial.injectionMode); }
  for (const key of ['scanMaxBytes','bufferBudgetMb','scanBufferMaxBytes','memoryPressurePercent','trafficLogRetentionMinutes'] as const) {
    if (partial[key] !== undefined) await writeSetting(SETTINGS_KEYS[key], partial[key], 'number');
  }
  if (partial.trafficLogEnabled !== undefined) await writeSetting(SETTINGS_KEYS.trafficLogEnabled, partial.trafficLogEnabled, 'boolean');
  if (partial.trafficLogEnabled === false) await clearTrafficLog();
  console.log('[threat-proxy] settings updated', Object.keys(partial));
  await syncGuest().catch(err => console.error('[threat-proxy] could not apply settings in the guest', err));

  return readSettings();
}

/**
 * Pull the two API keys out of the password vault via IntegrationService.
 *
 * Returns empty strings if the user hasn't connected the integration — the
 * mitmproxy addon gracefully degrades to URLhaus-only when keys are missing.
 * We never persist these to SullaSettingsModel; always resolve fresh so the
 * vault stays the single source of truth.
 */
export async function getApiKeys(): Promise<ThreatProxyCredentials> {
  let safeBrowsingApiKey = '';
  let virusTotalApiKey = '';

  try {
    const { getIntegrationService } = await import('@pkg/agent/services/IntegrationService');
    const svc = getIntegrationService();

    const [sbValues, vtValues] = await Promise.all([
      svc.getFormValues(INTEGRATION_IDS.safeBrowsing).catch(() => [] as Array<{ property: string; value?: string }>),
      svc.getFormValues(INTEGRATION_IDS.virusTotal).catch(() => [] as Array<{ property: string; value?: string }>),
    ]);

    safeBrowsingApiKey = sbValues.find((v: { property: string }) => v.property === 'api_key')?.value ?? '';
    virusTotalApiKey = vtValues.find((v: { property: string }) => v.property === 'api_key')?.value ?? '';
  } catch (err) {
    console.warn('[threat-proxy] IntegrationService not ready — keys unavailable', err);
  }

  return { safeBrowsingApiKey, virusTotalApiKey };
}

/**
 * Render settings + vault-sourced credentials into the proxy's config file
 * (config/proxy.json in its state directory). JSON, so values need no quoting.
 */
export function renderConfigFile(settings: ThreatProxySettings, creds: ThreatProxyCredentials): string {
  return `${ JSON.stringify({
    managedBy:                 'Sulla Desktop',
    safeBrowsingApiKey:        creds.safeBrowsingApiKey,
    virusTotalApiKey:          creds.virusTotalApiKey,
    allowlist:                 settings.allowlist,
    blockMode:                 settings.blockMode,
    injectionMode:             settings.injectionMode,
    scanMaxBytes: settings.scanMaxBytes, bufferBudgetMb: settings.bufferBudgetMb,
    scanBufferMaxBytes: settings.scanBufferMaxBytes, memoryPressurePercent: settings.memoryPressurePercent,
    trafficLogEnabled: settings.trafficLogEnabled, trafficLogRetentionMinutes: settings.trafficLogRetentionMinutes,
    injectionScanContentTypes: INJECTION_SCAN_CONTENT_TYPES,
  }, null, 2) }\n`;
}

// ── Guest delivery ───────────────────────────────────────────────────

/**
 * Called by the backend after the guest state directories exist, on every
 * managed-services reconciliation. Later setting changes and blocklist
 * refreshes are pushed through the same executor.
 */
export async function configureGuest(executor: VMExecutor): Promise<void> {
  guest = executor;
  await syncGuest();
  startWatcher();
}

export function clearGuest(executor: VMExecutor): void {
  if (guest === executor) {
    if (watcher) clearInterval(watcher);
    watcher = null;
    healthyProbes = failedProbes = 0;
    guest = undefined;
  }
}

/** Serialize guest writes so a settings change and a blocklist refresh never interleave. */
function queueGuestSync(task: (executor: VMExecutor) => Promise<void>): Promise<void> {
  const executor = guest;

  if (!executor) return Promise.resolve();
  const next = guestSync.then(() => task(executor));

  guestSync = next.catch(() => undefined);

  return next;
}

/** Push config, blocklist and egress policy. */
export function syncGuest(): Promise<void> {
  return queueGuestSync(async(executor) => {
    const [settings, creds] = await Promise.all([readSettings(), getApiKeys()]);

    await writeGuestConfig(executor, settings, creds);
    await copyBlocklistToGuest(executor);
    const policy: EgressPolicyState = settings.enabled ? effectivePolicy === 'enforced' ? 'enforced' : 'direct' : 'off';
    const changed = policy !== effectivePolicy;
    if (changed) transition(policy, settings.enabled ? 'health_check_pending' : 'disabled');
    if (changed) { await applyEgressPolicyNow(executor, policy); lastAppliedPolicy = policy; lastReconcileAt = Date.now(); }
  });
}

async function writeGuestConfig(executor: VMExecutor, settings: ThreatProxySettings, creds: ThreatProxyCredentials): Promise<void> {
  const staged = `${ path.posix.dirname(THREAT_PROXY_CONFIG_PATH) }/.proxy.json.new`;

  // writeFile streams the contents over stdin: the API keys never appear on a
  // command line or in the exec log. Only the proxy user can read the result.
  await executor.writeFile(staged, renderConfigFile(settings, creds), 0o600);
  await executor.execCommand({ root: true }, ...installStagedFileCommand(staged, THREAT_PROXY_CONFIG_PATH, '0600'));
}

async function copyBlocklistToGuest(executor: VMExecutor): Promise<void> {
  const source = getBlocklistHostPath();

  try {
    await fs.promises.access(source, fs.constants.R_OK);
  } catch {
    return; // Not fetched yet; refreshBlocklist() pushes it when it arrives.
  }
  const staged = '/tmp/sulla-threat-proxy-urlhaus.txt';

  await executor.copyFileIn(source, staged);
  await executor.execCommand({ root: true }, ...installStagedFileCommand(staged, THREAT_PROXY_BLOCKLIST_PATH, '0644'));
}

/**
 * Install (enabled) or remove (disabled) the guest firewall redirect of agent
 * web traffic. Exported for the agent launcher, which re-applies it before
 * every launch so a Docker restart can never leave agents unscanned.
 */
async function applyEgressPolicyNow(executor: Pick<VMExecutor, 'execCommand'>, state: EgressPolicyState): Promise<void> {
  await executor.execCommand({ root: true }, ...egressPolicyCommand(state));
}

/** All policy writes share guestSync's serialized queue. */
export function applyEgressPolicy(executor: Pick<VMExecutor, 'execCommand'>, state: EgressPolicyState | boolean): Promise<void> {
  return queueGuestSync(async() => { await applyEgressPolicyNow(executor, state === true ? 'enforced' : state === false ? 'off' : state); });
}

export function applyCurrentEgressPolicy(state: EgressPolicyState): Promise<void> {
  transition(state, state === 'direct' ? 'agent_launch_fail_open' : state === 'off' ? 'disabled' : 'healthy');
  return queueGuestSync(async executor => { await applyEgressPolicyNow(executor, state); });
}

export interface ThreatProxyStatus { state: 'running' | 'failing-open' | 'off' | 'starting' | 'standby'; reason: string; since: string; lastTransition: string; failOpenTransitions24h: number }

export function getStatus(): ThreatProxyStatus {
  const now = Date.now();
  while (failOpenTransitions.length && failOpenTransitions[0] < now - 86_400_000) failOpenTransitions.shift();
  return { state: statusReason === 'idle' ? 'standby' : !(guest) || effectivePolicy === 'off' ? (guest ? 'off' : 'starting') : effectivePolicy === 'direct' ? 'failing-open' : 'running', reason: statusReason, since: statusSince, lastTransition, failOpenTransitions24h: failOpenTransitions.length };
}

function transition(state: EgressPolicyState, reason: string): void {
  if (effectivePolicy === state && statusReason === reason) return;
  const from = effectivePolicy; effectivePolicy = state; statusReason = reason; statusSince = new Date().toISOString(); lastTransition = statusSince;
  if (state === 'direct' && from !== 'direct' && reason !== 'idle' && reason !== 'health_check_pending' && reason !== 'disabled') failOpenTransitions.push(Date.now());
  console.warn('[threat-proxy] egress policy transition', JSON.stringify({ from, to: state, reason, at: lastTransition }));
  for (const win of BrowserWindow.getAllWindows()) { if (!win.isDestroyed()) win.webContents.send('threat-proxy:status-changed', getStatus()); }
}

function startWatcher(): void {
  if (watcher) clearInterval(watcher);
  watcher = setInterval(() => { void checkProxyHealth(); }, 2_000);
  void checkProxyHealth();
}

function checkProxyHealth(): Promise<void> {
  if (healthCheck) return healthCheck;
  healthCheck = checkProxyHealthNow().finally(() => { healthCheck = undefined; });
  return healthCheck;
}

let lastAppliedPolicy: EgressPolicyState | undefined;
let lastReconcileAt = 0;
const RECONCILE_INTERVAL_MS = 60_000;

async function applyWatcherPolicy(executor: VMExecutor, state: EgressPolicyState): Promise<void> {
  if (lastAppliedPolicy === state && Date.now() - lastReconcileAt < RECONCILE_INTERVAL_MS) return;
  await applyEgressPolicy(executor, state);
  lastAppliedPolicy = state;
  lastReconcileAt = Date.now();
}

/** One guest command gathers every health signal without entering the proxy container. */
export const WATCHER_PROBE_SCRIPT = `set +e
name="$1"
agents=$(docker ps --filter network=sulla-agents --filter status=running --filter label=com.sulla.workload=agent -q 2>/dev/null | wc -l | tr -d ' ')
inspect=$(docker inspect --format '{{.State.Status}}|{{.State.Health.Status}}|{{.State.OOMKilled}}|{{.State.Restarting}}|{{.State.Pid}}' "$name" 2>/dev/null)
if [ -z "$inspect" ]; then echo "absent||||0|0|0|0|0|$agents"; exit 0; fi
IFS='|' read -r state health oom restarting pid <<EOF
$inspect
EOF
probe=0
if [ "$state" = running ]; then
  if command -v nc >/dev/null 2>&1; then nc -z -w1 127.0.0.1 8890 >/dev/null 2>&1; probe=$?
  elif command -v timeout >/dev/null 2>&1; then timeout 1 sh -c 'exec 3<>/dev/tcp/127.0.0.1/8890' >/dev/null 2>&1; probe=$?
  else probe=1; fi
fi
cg=$(awk -F: '$1=="0"{print $3}' /proc/"$pid"/cgroup 2>/dev/null)
base="/sys/fs/cgroup\${cg}"
used=$(cat "$base/memory.current" 2>/dev/null || echo 0)
limit=$(cat "$base/memory.max" 2>/dev/null || echo 0)
ca=0; [ ! -s "${THREAT_PROXY_PUBLIC_DIR}/ca-bundle.pem" ] || ca=1
missing=0
docker ps --filter network=sulla-agents --filter status=running --filter label=com.sulla.workload=agent --format '{{.Label "sulla.threat-proxy.ca"}}' 2>/dev/null | grep -qx absent && missing=1
echo "$state|$health|$oom|$restarting|$probe|$used|$limit|$ca|$missing|$agents"`;

/** Health signals gathered by WATCHER_PROBE_SCRIPT, typed. */
export interface EgressProbe {
  state: string; health: string; oomKilled: boolean; restarting: boolean; tcpOk: boolean;
  memCurrent: number; memMax: number; caPresent: boolean; agentsWithoutCa: boolean; runningAgents: number;
}

export interface EgressCounters { healthyTicks: number; failedProbes: number }

export interface EgressDecision {
  /** Policy to apply, or null to keep the current one (hold). */
  policy: EgressPolicyState | null;
  status: 'running' | 'failing-open' | 'standby' | 'hold';
  reason: string;
  countsAsFailOpen: boolean;
  next: EgressCounters;
}

/** Parses the probe's pipe-separated line. Returns null for anything that is not a complete probe. */
export function parseWatcherProbe(output: string): EgressProbe | null {
  const fields = output.trim().split('|');
  if (fields.length !== 10) return null;
  const [state, health, oom, restarting, probe, usedRaw, limitRaw, ca, missing, agents] = fields;
  if (!/^\d+$/.test(probe) || !/^\d+$/.test(agents)) return null;
  return {
    state, health, oomKilled: oom === 'true', restarting: restarting === 'true', tcpOk: probe === '0',
    memCurrent: Number(usedRaw), memMax: Number(limitRaw), caPresent: ca === '1', agentsWithoutCa: missing === '1',
    runningAgents: Number(agents),
  };
}

/** Pure egress decision. Same branch order and counter updates as the watcher it replaces. */
export function decideEgress(probe: EgressProbe | null, prev: EgressCounters): EgressDecision {
  const failOpen = (reason: string, next: EgressCounters): EgressDecision => ({ policy: 'direct', status: 'failing-open', reason, countsAsFailOpen: true, next });
  if (!probe) return failOpen('probe_parse_error', { healthyTicks: 0, failedProbes: prev.failedProbes });
  if (probe.runningAgents === 0) return { policy: 'direct', status: 'standby', reason: 'idle', countsAsFailOpen: false, next: { healthyTicks: 0, failedProbes: 0 } };
  if (probe.agentsWithoutCa) return failOpen('agent_without_ca', { healthyTicks: 0, failedProbes: prev.failedProbes });
  if (probe.state !== 'running' || probe.health !== 'healthy' || probe.oomKilled || probe.restarting) {
    return failOpen(`proxy_${probe.state}_${probe.health}_oom_${probe.oomKilled}_restarting_${probe.restarting}`, { healthyTicks: 0, failedProbes: 0 });
  }
  if (!probe.tcpOk) {
    const failedProbes = prev.failedProbes + 1;
    if (failedProbes >= 2) return failOpen('probe_failed_twice', { healthyTicks: 0, failedProbes });
    return { policy: null, status: 'hold', reason: 'probe_failed_once', countsAsFailOpen: false, next: { healthyTicks: 0, failedProbes } };
  }
  if (Number.isFinite(probe.memCurrent) && Number.isFinite(probe.memMax) && probe.memMax > 0 && probe.memCurrent >= probe.memMax * 0.9) {
    return failOpen('memory_pressure', { healthyTicks: 0, failedProbes: 0 });
  }
  if (!probe.caPresent) return failOpen('ca_bundle_missing', { healthyTicks: 0, failedProbes: 0 });
  const healthyTicks = prev.healthyTicks + 1;
  if (healthyTicks >= 3) return { policy: 'enforced', status: 'running', reason: 'healthy', countsAsFailOpen: false, next: { healthyTicks, failedProbes: 0 } };
  return { policy: null, status: 'hold', reason: 'healthy_pending', countsAsFailOpen: false, next: { healthyTicks, failedProbes: 0 } };
}

async function checkProxyHealthNow(): Promise<void> {
  const executor = guest;
  if (!executor) return;
  try {
    const settings = await readSettings();
    if (!settings.enabled) { healthyProbes = failedProbes = 0; transition('off', 'disabled'); await applyWatcherPolicy(executor, 'off'); return; }
    const data = await executor.execCommand({ root: true, capture: true }, 'sh', '-c', WATCHER_PROBE_SCRIPT, 'threat-proxy-watch', THREAT_PROXY_CONTAINER);
    const decision = decideEgress(parseWatcherProbe(data), { healthyTicks: healthyProbes, failedProbes });
    healthyProbes = decision.next.healthyTicks;
    failedProbes = decision.next.failedProbes;
    if (decision.policy === null) return;
    transition(decision.policy, decision.reason);
    await applyWatcherPolicy(executor, decision.policy);
  } catch (err: any) {
    healthyProbes = 0; failedProbes++;
    transition('direct', `health_check_error:${err?.message ?? String(err)}`);
    const current = guest;
    if (current) await applyWatcherPolicy(current, 'direct').catch(() => { lastAppliedPolicy = undefined; });
  }
}

/** Whether agent containers must go through the proxy (and so trust its CA). */
export async function egressEnforced(): Promise<boolean> {
  return (await readSettings()).enabled;
}

// ── URLhaus blocklist refresh ────────────────────────────────────────

export async function refreshBlocklist(force = false): Promise<{ ok: boolean; hostCount: number; path: string; error?: string }> {
  const target = getBlocklistHostPath();

  if (!force) {
    try {
      const stat = await fs.promises.stat(target);
      const ageMs = Date.now() - stat.mtimeMs;

      if (ageMs < URLHAUS_REFRESH_INTERVAL_MS) {
        console.log(`[threat-proxy] blocklist age ${ Math.round(ageMs / 1000 / 60) }min — skipping refresh`);
        const hostCount = await countNonCommentLines(target);

        return { ok: true, hostCount, path: target };
      }
    } catch {
      // Missing — fall through to fetch.
    }
  }

  console.log('[threat-proxy] refreshing URLhaus blocklist', { sources: URLHAUS_SOURCES, target });
  await fs.promises.mkdir(path.dirname(target), { recursive: true });

  try {
    // Stream directly to a tmp file, then atomically rename. Never holds the
    // full body in the main-process heap. Capped at URLHAUS_MAX_BYTES so a
    // misbehaving mirror can't balloon memory on app boot.
    const tmpPath = `${ target }.tmp`;
    const failures: string[] = [];
    let fetched = false;

    for (const source of URLHAUS_SOURCES) {
      try {
        await downloadToFile(source, tmpPath, URLHAUS_MAX_BYTES);
        // An error page served with 200 must never replace a good blocklist.
        if (!await looksLikeHostsFile(tmpPath)) {
          throw new Error(`response from ${ source } is not a hosts file`);
        }
        fetched = true;
        break;
      } catch (err: any) {
        failures.push(err?.message ?? String(err));
      }
    }
    if (!fetched) {
      await fs.promises.unlink(tmpPath).catch(() => undefined);
      throw new Error(failures.join('; '));
    }
    await fs.promises.rename(tmpPath, target);

    const hostCount = await countNonCommentLines(target);

    await writeSetting(SETTINGS_KEYS.blocklistUpdatedAt, new Date().toISOString());
    console.log(`[threat-proxy] blocklist refreshed: ${ hostCount } hosts`);
    await queueGuestSync(copyBlocklistToGuest).catch(err => console.error('[threat-proxy] blocklist delivery to the guest failed', err));

    return { ok: true, hostCount, path: target };
  } catch (err: any) {
    const message = err?.message ?? String(err);

    console.error('[threat-proxy] blocklist refresh failed', message);

    return { ok: false, hostCount: 0, path: target, error: message };
  }
}

/**
 * Count non-comment lines by streaming the file a line at a time instead of
 * reading it whole. A URLhaus hostfile can be tens of MB; the previous
 * readFile implementation held the entire body in memory just to run split
 * and filter.
 */
async function countNonCommentLines(p: string): Promise<number> {
  try {
    const stream = fs.createReadStream(p, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let count = 0;
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

/** True when the first data line is a hosts entry ("0.0.0.0 bad.example" or "bad.example"), not HTML or empty. */
async function looksLikeHostsFile(p: string): Promise<boolean> {
  const stream = fs.createReadStream(p, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith('#')) continue;
      const host = trimmed.split(/\s+/).pop() ?? '';

      return /^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(host);
    }

    return false;
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Stream an HTTP(S) download directly to disk with a hard byte cap. Never
 * buffers the full body in the Electron main-process heap — a critical
 * property when the URLhaus hostfile can be tens of MB and this runs on
 * app boot. Follows one hop of HTTP redirect (URLhaus occasionally 30x's).
 */
function downloadToFile(targetUrl: string, destPath: string, maxBytes: number, redirectsLeft = 2): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'http:' ? http : https;
    const req = client.get(targetUrl, { timeout: 20_000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) {
          res.resume();
          reject(new Error(`too many redirects fetching ${ targetUrl }`));
          return;
        }
        const next = new URL(res.headers.location, targetUrl).toString();
        res.resume();
        downloadToFile(next, destPath, maxBytes, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${ res.statusCode } from ${ targetUrl }`));
        return;
      }

      const fileStream = fs.createWriteStream(destPath, { mode: 0o644 });
      let bytesWritten = 0;
      let aborted = false;

      const abortWith = (err: Error) => {
        if (aborted) return;
        aborted = true;
        // Tear down both ends so no trickle of late data can reawaken handlers.
        res.destroy();
        fileStream.destroy();
        fs.promises.unlink(destPath).catch(() => { /* already gone */ });
        reject(err);
      };

      res.on('data', (chunk: Buffer) => {
        bytesWritten += chunk.length;
        if (bytesWritten > maxBytes) {
          abortWith(new Error(`response exceeded ${ maxBytes } byte cap fetching ${ targetUrl }`));
        }
      });
      res.on('error', abortWith);
      fileStream.on('error', abortWith);
      fileStream.on('finish', () => {
        if (!aborted) resolve();
      });
      res.pipe(fileStream);
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`timeout fetching ${ targetUrl }`));
    });
  });
}

// ── Lifecycle ────────────────────────────────────────────────────────

/**
 * Initialize the threat-proxy subsystem.
 * Called once from background.ts after the app is ready.
 */
export function initialize(): void {
  if (initialized) {
    console.warn('[threat-proxy] already initialized — skipping');

    return;
  }
  initialized = true;
  console.log('[threat-proxy] initializing');

  registerIpcHandlers();

  // Kick off an async blocklist fetch — don't await; the proxy reloads the
  // file from its state directory whenever a newer copy is delivered.
  refreshBlocklist(false).catch(err => console.error('[threat-proxy] initial blocklist fetch failed', err));

  // Periodic refresh — 6h matches the file's TTL expectation in url_filter.py.
  // The config is re-delivered too, so rotated vault API keys reach the proxy.
  refreshTimer = setInterval(() => {
    refreshBlocklist(false).catch(err => console.error('[threat-proxy] periodic refresh failed', err));
    syncGuest().catch(err => console.error('[threat-proxy] periodic config sync failed', err));
  }, URLHAUS_REFRESH_INTERVAL_MS);

  console.log('[threat-proxy] initialized');
}

export async function shutdown(): Promise<void> {
  if (!initialized) {
    return;
  }
  console.log('[threat-proxy] shutting down');
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  initialized = false;
}

export { ThreatDailyCounters } from '../security/ThreatProxyDailyCounters';
/** Sum persisted UTC-hour buckets within the host's local calendar day. */
export async function getDailyCounters(): Promise<ThreatDailyCounters | null> {
  if (!guest) return null;
  try {
    const counterPath = `${ THREAT_PROXY_STATE_DIR }/daily-counters.json`;
    const output = await guest.execCommand({ root: true, capture: true }, 'sh', '-c', 'cat -- "$1"', 'daily-counters', counterPath);
    const parsed = JSON.parse(output) as { hours?: unknown };
    if (!parsed.hours || typeof parsed.hours !== 'object' || Array.isArray(parsed.hours)) return null;
    return ThreatProxyDailyCounters.sumLocalDay(parsed.hours as Record<string, unknown>);
  } catch { return null }
}

export interface TrafficLogRequest { limit?: number; verdict?: string; search?: string }
export async function getTrafficLog(input: TrafficLogRequest = {}): Promise<{ entries: Record<string, any>[]; error?: string }> {
  if (!guest) return { entries: [], error: 'The Sulla runtime is not running' };
  try {
    const output = await guest.execCommand({ root: true, capture: true }, 'sh', '-c', 'for f in "$1" "$1.1"; do [ ! -f "$f" ] || tail -c 2097152 "$f"; done', 'traffic-log', THREAT_PROXY_TRAFFIC_LOG_PATH);
    const settings = await readSettings(); const cutoff = Date.now() - settings.trafficLogRetentionMinutes * 60_000;
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 200)));
    const entries = output.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
      .filter(entry => new Date(entry.ts).getTime() >= cutoff)
      .map(entry => ({ ...entry, path: typeof entry.path === 'string' ? entry.path.replace(/([?&][^=&#]+)=([^&#]*)/g, '$1=…') : entry.path }))
      .filter(entry => !input.verdict || entry.verdict === input.verdict)
      .filter(entry => !input.search || `${entry.host ?? ''} ${entry.path ?? ''}`.toLowerCase().includes(input.search.toLowerCase()))
      .sort((a,b) => new Date(b.ts).getTime() - new Date(a.ts).getTime()).slice(0, limit);
    return { entries };
  } catch (err: any) { return { entries: [], error: err?.message ?? String(err) }; }
}

export async function clearTrafficLog(): Promise<void> {
  if (!guest) return;
  await guest.execCommand({ root: true }, 'sh', '-c', ': > "$1"; : > "$1.1"', 'clear-traffic-log', THREAT_PROXY_TRAFFIC_LOG_PATH);
}

// ── IPC handlers ─────────────────────────────────────────────────────

function registerIpcHandlers(): void {
  ipcMain.handle('threat-proxy:get-settings', async() => {
    try {
      // We surface which integrations are connected (without leaking keys) so
      // the settings UI can show a status pill. The keys themselves live in the
      // vault and only reach the proxy's private config file in the guest.
      const [settings, creds] = await Promise.all([readSettings(), getApiKeys()]);

      return {
        ok:       true,
        settings,
        keyStatus: {
          safeBrowsing: !!creds.safeBrowsingApiKey,
          virusTotal:   !!creds.virusTotalApiKey,
        },
      };
    } catch (err: any) {
      console.error('[threat-proxy] get-settings failed', err);

      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('threat-proxy:set-settings', async(_event, partial: Partial<ThreatProxySettings>) => {
    try {
      const settings = await setSettings(partial ?? {});

      return { ok: true, settings };
    } catch (err: any) {
      console.error('[threat-proxy] set-settings failed', err);

      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('threat-proxy:get-status', () => getStatus());
  ipcMain.handle('threat-proxy:get-traffic-log', (_event, request: TrafficLogRequest) => getTrafficLog(request));
  ipcMain.handle('threat-proxy:clear-traffic-log', async() => { try { await clearTrafficLog(); return { ok: true }; } catch (err: any) { return { ok: false, error: err?.message ?? String(err) }; } });

  ipcMain.handle('threat-proxy:refresh-blocklist', async() => {
    return refreshBlocklist(true);
  });

  ipcMain.handle('threat-proxy:blocklist-status', async() => {
    const target = getBlocklistHostPath();

    try {
      const stat = await fs.promises.stat(target);
      const hostCount = await countNonCommentLines(target);

      return {
        ok:        true,
        path:      target,
        hostCount,
        updatedAt: stat.mtime.toISOString(),
      };
    } catch {
      return { ok: false, path: target, hostCount: 0, updatedAt: null };
    }
  });

  ipcMain.handle('threat-proxy:sync', async() => {
    try {
      await syncGuest();

      return { ok: true, guest: !!guest };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  // The proxy logs one JSON line per decision to stdout (`docker logs`).
  ipcMain.handle('threat-proxy:logs', async(_event, lines = 200) => {
    if (!guest) return { ok: false, error: 'The Sulla runtime is not running', lines: [] };
    try {
      const tail = String(Math.max(1, Math.min(Number(lines) || 200, 2000)));
      const output = await guest.execCommand({ root: true, capture: true }, 'docker', 'logs', '--tail', tail, THREAT_PROXY_CONTAINER);

      return { ok: true, lines: output.split('\n').filter(Boolean) };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err), lines: [] };
    }
  });
}

export { getBlocklistHostPath };
