// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '' }, session: {} }));
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { getSetting: vi.fn() } }));
vi.mock('@pkg/backend/sullaRuntime/state', () => ({ isSullaRuntimeActive: vi.fn(() => true) }));
vi.mock('@pkg/config/settingsImpl', () => ({ getSettings: vi.fn(() => ({ application: {} })) }));
vi.mock('@pkg/agent/services/DesktopVaultClient', () => ({ getDesktopVaultClient: vi.fn() }));
vi.mock('@pkg/agent/services/VaultKeyService', () => ({ getVaultKeyService: vi.fn() }));
vi.mock('@pkg/main/threat-proxy', () => ({ getSettings: vi.fn(), getStatus: vi.fn(), getTrafficLog: vi.fn() }));
import { SecurityCheck, SecurityCheckService } from './SecurityCheckService';

describe('SecurityCheckService contract', () => {
  it('scores only checks that were actually evaluated', () => {
    const report = SecurityCheckService.createReport('start', [
      { id:'runtime', label:'Runtime', status:'pass', detail:'up' },
      { id:'vault', label:'Vault', status:'warn', detail:'locked' },
      { id:'containers', label:'Containers', status:'fail', detail:'unavailable' },
      { id:'signature', label:'Signature', status:'not_checked', detail:'dev build' },
    ], 'finish');
    expect(report.score).toEqual({ on: 1, total: 3 });
  });

  it('turns a timed-out dependency into a fail result', async() => {
    // risk: security visibility must complete even if an inspected service hangs.
    const check = new SecurityCheck('runtime', () => new Promise(() => undefined), 1);
    await expect(check.run()).resolves.toMatchObject({ id:'runtime', status:'fail', detail:'Check timed out' });
  });

  it('returns not_checked for signature verification outside packaged macOS', () => {
    expect(SecurityCheckService.signatureStatus('darwin', true)).toBeUndefined();
    expect(SecurityCheckService.signatureStatus('darwin', false)).toBe('not_checked');
    expect(SecurityCheckService.signatureStatus('linux', true)).toBe('not_checked');
  });

  it('hides threat data when disabled and never estimates totals from a missing log', () => {
    expect(SecurityCheckService.threatSummary(false, [], '2026-11-18')).toBeNull();
    expect(SecurityCheckService.threatSummary(true, [], '2026-11-18')).toEqual({ scannedToday: null, blockedToday: null, recentBlocked: [] });
  });

  it('does not treat the bounded traffic-log tail as a full-day count', () => {
    const summary = SecurityCheckService.threatSummary(true, [
      { ts:'2026-11-18T09:00:00.000Z', verdict:'blocked', host:'example.test' },
    ], '2026-11-18');
    expect(summary).toMatchObject({ scannedToday:null, blockedToday:null, recentBlocked:[{ host:'example.test' }] });
  });
});
