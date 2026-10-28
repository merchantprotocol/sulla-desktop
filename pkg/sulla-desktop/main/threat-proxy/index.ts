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

import { ipcMain } from 'electron';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import type { VMExecutor } from '@pkg/backend/backend';
import {
  egressPolicyCommand, installStagedFileCommand, THREAT_PROXY_BLOCKLIST_PATH, THREAT_PROXY_CONFIG_PATH, THREAT_PROXY_CONTAINER,
} from '@pkg/backend/threatProxyEgress';
import Logging from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';

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
};

/** Host-side cache of the URLhaus blocklist, copied into the proxy's state directory in the guest. */
const URLHAUS_SRC = 'https://urlhaus.abuse.ch/downloads/hostfile/';
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
  };
}

async function writeSetting(key: string, value: unknown, type: 'string' | 'boolean' = 'string'): Promise<void> {
  await SullaSettingsModel.set(key, value as any, type);
}

export async function getSettings(): Promise<ThreatProxySettings> {
  return readSettings();
}

export async function setSettings(partial: Partial<ThreatProxySettings>): Promise<ThreatProxySettings> {
  if (partial.enabled !== undefined) {
    await writeSetting(SETTINGS_KEYS.enabled, partial.enabled, 'boolean');
  }
  if (partial.allowlist !== undefined) {
    await writeSetting(SETTINGS_KEYS.allowlist, partial.allowlist);
  }
  if (partial.blockMode !== undefined) {
    await writeSetting(SETTINGS_KEYS.blockMode, partial.blockMode);
  }
  if (partial.injectionMode !== undefined) {
    await writeSetting(SETTINGS_KEYS.injectionMode, partial.injectionMode);
  }
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
}

export function clearGuest(executor: VMExecutor): void {
  if (guest === executor) guest = undefined;
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
    await applyEgressPolicy(executor, settings.enabled);
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
export async function applyEgressPolicy(executor: Pick<VMExecutor, 'execCommand'>, enforce: boolean): Promise<void> {
  await executor.execCommand({ root: true }, ...egressPolicyCommand(enforce));
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

  console.log('[threat-proxy] refreshing URLhaus blocklist', { source: URLHAUS_SRC, target });
  await fs.promises.mkdir(path.dirname(target), { recursive: true });

  try {
    // Stream directly to a tmp file, then atomically rename. Never holds the
    // full body in the main-process heap. Capped at URLHAUS_MAX_BYTES so a
    // misbehaving mirror can't balloon memory on app boot.
    const tmpPath = `${ target }.tmp`;
    await downloadToFile(URLHAUS_SRC, tmpPath, URLHAUS_MAX_BYTES);
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
