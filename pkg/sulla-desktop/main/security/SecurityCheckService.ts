// SPDX-License-Identifier: GPL-2.0-or-later
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app } from 'electron';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { isSullaRuntimeActive } from '@pkg/backend/sullaRuntime/state';
import { getSettings } from '@pkg/config/settingsImpl';
import { getDesktopVaultClient } from '@pkg/agent/services/DesktopVaultClient';
import { getVaultKeyService } from '@pkg/agent/services/VaultKeyService';
import { getSettings as getThreatSettings, getStatus as getThreatStatus, getTrafficLog } from '@pkg/main/threat-proxy';
import type { CheckId, CheckStatus, SecurityCheckReport, SecurityCheckResult, SecuritySummary } from './types';

const runFile = promisify(execFile);
const CHECK_TIMEOUT_MS = 5_000;
const LABELS: Record<CheckId, string> = { runtime:'Runtime', containers:'Container isolation', threatProxy:'Threat proxy', blocklist:'URLhaus blocklist', vault:'Vault', filesEncryption:'Files encryption', hostAccess:'Host access', signature:'App signature' };
type CheckReader = () => Promise<SecurityCheckResult>;

/** One bounded check; a slow dependency becomes a visible failure rather than stalling the report. */
export class SecurityCheck {
  constructor(readonly id: CheckId, private readonly read: CheckReader, private readonly timeoutMs = CHECK_TIMEOUT_MS) {}
  async run(): Promise<SecurityCheckResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.read(), new Promise<SecurityCheckResult>((_, reject) => { timer = setTimeout(() => reject(new Error('Check timed out')), this.timeoutMs) })]);
    } catch (error) {
      return { id: this.id, label: LABELS[this.id], status: 'fail', detail: error instanceof Error ? error.message : String(error) };
    } finally { if (timer) clearTimeout(timer) }
  }
}

/** Main-process security diagnostics and summary. Source-absent summary rows deliberately remain null. */
export class SecurityCheckService {
  private lastReport: SecurityCheckReport | null = null;
  constructor(private readonly progress: (result: SecurityCheckResult) => void = () => undefined) {}

  async runChecks(): Promise<SecurityCheckReport> {
    const startedAt = new Date().toISOString();
    const results: SecurityCheckResult[] = [];
    for (const check of this.checks()) {
      const result = await check.run();
      results.push(result);
      this.progress(result);
    }
    const report: SecurityCheckReport = SecurityCheckService.createReport(startedAt, results);
    this.lastReport = report;
    return report;
  }

  static createReport(startedAt: string, checks: SecurityCheckResult[], finishedAt = new Date().toISOString()): SecurityCheckReport {
    const scored = checks.filter(result => result.status !== 'not_checked');
    return { startedAt, finishedAt, checks, score: { on: scored.filter(result => result.status === 'pass').length, total: scored.length } };
  }

  static signatureStatus(platform: string, packaged: boolean): CheckStatus | undefined {
    return platform === 'darwin' && packaged ? undefined : 'not_checked';
  }

  static threatSummary(enabled: boolean, unavailable: boolean, entries: Record<string, any>[], today: string): SecuritySummary['threat'] {
    if (!enabled || unavailable) return null;
    const todayRows = entries.filter(row => typeof row.ts === 'string' && row.ts.slice(0, 10) === today);
    const blocked = todayRows.filter(row => row.verdict === 'blocked' || row.verdict === 'block');
    // Traffic log is a bounded tail, not an authoritative full-day aggregate.
    // Keep totals null rather than presenting a partial sample as daily counts.
    return { scannedToday: null, blockedToday: null, recentBlocked: blocked.slice(0, 10).map(row => ({ host: String(row.host ?? ''), reason: String(row.reason ?? row.verdict ?? 'blocked'), at: String(row.ts) })) };
  }

  async summary(): Promise<SecuritySummary> {
    const [locked, threatSettings, threatStatus, traffic] = await Promise.all([
      Promise.resolve(getVaultKeyService().isUnlocked()).then(unlocked => !unlocked).catch(() => null),
      getThreatSettings().catch(() => null), Promise.resolve(getThreatStatus()), getTrafficLog({ limit: 500 }).catch(() => null),
    ]);
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const rows = traffic?.error ? [] : traffic?.entries ?? [];
    const threat = SecurityCheckService.threatSummary(Boolean(threatSettings?.trafficLogEnabled), Boolean(traffic?.error), rows, today);
    let vault: SecuritySummary['vault'] = null;
    if (locked !== null) {
      const configured = await SullaSettingsModel.getSetting('vault.autoLockMinutes', null).catch(() => null);
      vault = { locked, autoLockMinutes: Number.isFinite(Number(configured)) && configured !== null ? Number(configured) : null };
    }
    return { lastReport: this.lastReport, vault, threat: threatStatus ? threat : null, approvals: null, rules: null, activity: null };
  }

  private checks(): SecurityCheck[] {
    const check = (id: CheckId, read: CheckReader) => new SecurityCheck(id, read);
    return [
      check('runtime', async() => { const active = isSullaRuntimeActive(); return { id:'runtime', label:LABELS.runtime, status:active?'pass':'fail', detail:active?'Sulla runtime is running':'Sulla runtime is not running' } }),
      check('containers', async() => {
        if (!isSullaRuntimeActive()) return { id:'containers', label:LABELS.containers, status:'fail', detail:'Container isolation is unavailable because the runtime is stopped' };
        const { agentImagePresent } = await import('@pkg/agent/services/AgentContainerLauncher');
        const available = await agentImagePresent();
        return { id:'containers', label:LABELS.containers, status:available?'pass':'warn', detail:available?'Agent container image is available in the runtime':'Runtime is running; agent container image is not currently available' };
      }),
      check('threatProxy', async() => { const [settings, status] = await Promise.all([getThreatSettings(), Promise.resolve(getThreatStatus())]); const enabled = settings.enabled && status.state === 'running'; return { id:'threatProxy', label:LABELS.threatProxy, status:enabled?'pass':'warn', detail:enabled?'Enabled and running':settings.enabled?`Enabled; ${status.state}`:'Disabled' } }),
      check('blocklist', async() => {
        const updatedAt = await SullaSettingsModel.getSetting('threatProxy.blocklistUpdatedAt', null);
        if (typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt))) return { id:'blocklist', label:LABELS.blocklist, status:'fail', detail:'Blocklist refresh time is unavailable' };
        const age = Date.now() - Date.parse(updatedAt); const hours = Math.round(age / 3_600_000);
        return { id:'blocklist', label:LABELS.blocklist, status:age > 12 * 3_600_000?'warn':'pass', detail:`Last refreshed ${hours} hours ago` };
      }),
      check('vault', async() => { const status = await getDesktopVaultClient().status(); return { id:'vault', label:LABELS.vault, status:'pass', detail:`Vault service is available and encrypted; ${status.unlocked?'unlocked':'locked'}` } }),
      check('filesEncryption', async() => {
        const keyPath = process.env.SULLA_FILES_MASTER_KEY_PATH;
        if (!keyPath) return { id:'filesEncryption', label:LABELS.filesEncryption, status:'fail', detail:'Files encryption key is not configured' };
        await fs.access(keyPath);
        const { SullaFilesBootstrapProcess } = await import('@pkg/main/sullaFilesBootstrapProcess');
        const { session } = await import('electron');
        const response = await session.defaultSession.fetch(`${ SullaFilesBootstrapProcess.API }/healthz`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`Files service health check returned HTTP ${response.status}`);
        const payload = await response.json() as { ok?: boolean; mode?: string };
        if (payload.ok !== true) throw new Error('Files service is not ready');
        return { id:'filesEncryption', label:LABELS.filesEncryption, status:'pass', detail:'Files service is up and its OS-protected encryption key is present' };
      }),
      check('hostAccess', async() => { const enabled = getSettings().application.hostAccess === true; return { id:'hostAccess', label:LABELS.hostAccess, status:enabled?'warn':'pass', detail:enabled?'Host access is enabled':'Host access is disabled' } }),
      check('signature', async() => {
        const notChecked = SecurityCheckService.signatureStatus(process.platform, app.isPackaged);
        if (notChecked) return { id:'signature', label:LABELS.signature, status:notChecked, detail:'Code signature verification is only available for packaged macOS apps' };
        const bundle = path.resolve(app.getPath('exe'), '..', '..', '..');
        await runFile('codesign', ['--verify', '--deep', '--strict', bundle], { timeout: CHECK_TIMEOUT_MS });
        return { id:'signature', label:LABELS.signature, status:'pass', detail:'App code signature verified' };
      }),
    ];
  }
}
