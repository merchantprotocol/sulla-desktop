/**
 * @module threat-proxy
 *
 * # Sulla Threat Proxy — Electron-side lifecycle
 *
 * The actual proxy runs *inside* the Lima VM as an OpenRC service
 * (`sulla-threat-proxy`, spawning `mitmdump` on 127.0.0.1:8888). This module
 * is the host-side glue:
 *
 *   - Persists user-facing settings (API keys, allowlist, modes) via SullaSettingsModel.
 *   - Exposes IPC handlers so the UI can read status + logs and toggle modes.
 *   - Drives the URLhaus blocklist refresh on a timer (fetched from the host
 *     because the VM's own internet access depends on the proxy working).
 *
 * The installation + start/stop of the in-VM service lives in
 * `LimaBackend.installThreatProxy()` (see backend/lima.ts). That keeps all
 * VM-touching code inside the Lima lifecycle methods where it belongs.
 */

import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { URL } from 'url';

import { ipcMain } from 'electron';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
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

/** Host-side cache of the URLhaus blocklist. Refreshed into the VM-mounted resources dir. */
const URLHAUS_SRC = 'https://urlhaus.abuse.ch/downloads/hostfile/';
const URLHAUS_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Where the VM-facing blocklist lives on the host; paths.altAppHome is writable + mounted into the VM. */
function getBlocklistHostPath(): string {
  return path.join(paths.altAppHome, 'threat-proxy', 'blocklist', 'urlhaus.txt');
}

/** Path to the in-VM log file, surfaced via mount so we can tail without execing into the VM. */
function getVmLogHostHint(): string {
  // Lima mounts /Users + paths.logs; the in-VM /var/log/sulla-threat-proxy.log
  // isn't directly reachable from the host. The service reads it via limactl shell.
  return '/var/log/sulla-threat-proxy.log';
}

let initialized = false;
let refreshTimer: NodeJS.Timeout | null = null;

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
 * Render settings + vault-sourced credentials into /etc/sulla-proxy.env.
 * Writing happens inside the VM; this function produces the body text.
 */
export function renderEnvFile(settings: ThreatProxySettings, creds: ThreatProxyCredentials): string {
  const lines: string[] = [
    '# /etc/sulla-proxy.env — managed by Sulla Desktop. Do not edit by hand.',
    '# API keys sourced from the password vault (IntegrationService).',
    `GOOGLE_SAFE_BROWSING_API_KEY=${ shellQuote(creds.safeBrowsingApiKey) }`,
    `VT_API_KEY=${ shellQuote(creds.virusTotalApiKey) }`,
    `SULLA_PROXY_ALLOWLIST=${ shellQuote(settings.allowlist) }`,
    `SULLA_PROXY_BLOCK_MODE=${ shellQuote(settings.blockMode) }`,
    `SULLA_INJECTION_MODE=${ shellQuote(settings.injectionMode) }`,
    `SULLA_INJECTION_SCAN_CONTENT_TYPES=${ shellQuote('text/html,text/plain,application/json,text/markdown,text/xml,application/xml') }`,
    '',
  ];

  return lines.join('\n');
}

function shellQuote(value: string): string {
  if (value === '') {
    return '""';
  }
  // Simple, conservative quoter — wrap in single quotes and escape existing single quotes.
  return `'${ value.replace(/'/g, '\'\\\'\'') }'`;
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
    const body = await fetchText(URLHAUS_SRC);
    const tmpPath = `${ target }.tmp`;

    await fs.promises.writeFile(tmpPath, body, { mode: 0o644 });
    await fs.promises.rename(tmpPath, target);

    const hostCount = await countNonCommentLines(target);

    await writeSetting(SETTINGS_KEYS.blocklistUpdatedAt, new Date().toISOString());
    console.log(`[threat-proxy] blocklist refreshed: ${ hostCount } hosts`);

    return { ok: true, hostCount, path: target };
  } catch (err: any) {
    const message = err?.message ?? String(err);

    console.error('[threat-proxy] blocklist refresh failed', message);

    return { ok: false, hostCount: 0, path: target, error: message };
  }
}

async function countNonCommentLines(p: string): Promise<number> {
  try {
    const body = await fs.promises.readFile(p, 'utf-8');

    return body.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#')).length;
  } catch {
    return 0;
  }
}

function fetchText(targetUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'http:' ? http : https;
    const req = client.get(targetUrl, { timeout: 20_000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // One hop of redirect is enough; URLhaus occasionally redirects.
        fetchText(new URL(res.headers.location, targetUrl).toString()).then(resolve, reject);
        res.resume();

        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${ res.statusCode } from ${ targetUrl }`));
        res.resume();

        return;
      }
      const chunks: Buffer[] = [];

      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
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

  // Kick off an async blocklist fetch — don't await; the VM will read whatever
  // is there when the proxy starts, and subsequent refreshes update it.
  refreshBlocklist(false).catch(err => console.error('[threat-proxy] initial blocklist fetch failed', err));

  // Periodic refresh — 6h matches the file's TTL expectation in url_filter.py.
  refreshTimer = setInterval(() => {
    refreshBlocklist(false).catch(err => console.error('[threat-proxy] periodic refresh failed', err));
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
      // vault and are read only by the in-VM proxy install path.
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

  ipcMain.handle('threat-proxy:vm-log-path', () => {
    return { path: getVmLogHostHint() };
  });
}

export { getBlocklistHostPath };
