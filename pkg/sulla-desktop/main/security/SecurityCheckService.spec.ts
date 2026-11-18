// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { SecurityCheck, SecurityCheckService } from './SecurityCheckService';

describe('SecurityCheckService contract', () => {
  it('scores only checks that were actually evaluated', () => {
    const report = SecurityCheckService.createReport('start', [
      { id:'runtime', label:'Runtime', status:'pass', detail:'up' },
      { id:'vault', label:'Vault', status:'warn', detail:'locked' },
      { id:'signature', label:'Signature', status:'not_checked', detail:'dev build' },
    ], 'finish');
    expect(report.score).toEqual({ on: 1, total: 2 });
  });

  it('turns a timed-out dependency into a fail result', async() => {
    // risk: security visibility must complete even if an inspected service hangs.
    const check = new SecurityCheck('runtime', () => new Promise(() => undefined), 1);
    await expect(check.run()).resolves.toMatchObject({ id:'runtime', status:'fail', detail:'Check timed out' });
  });

  it('skips signature verification except on packaged macOS', () => {
    expect(SecurityCheckService.signatureApplicable('darwin', true)).toBe(true);
    expect(SecurityCheckService.signatureApplicable('darwin', false)).toBe(false);
    expect(SecurityCheckService.signatureApplicable('linux', true)).toBe(false);
  });

  it('returns null threat totals when logging is disabled or unavailable', () => {
    expect(SecurityCheckService.threatSummary(false, false, [], '2026-11-18')).toBeNull();
    expect(SecurityCheckService.threatSummary(true, true, [], '2026-11-18')).toBeNull();
  });

  it('does not treat the bounded traffic-log tail as a full-day count', () => {
    const summary = SecurityCheckService.threatSummary(true, false, [
      { ts:'2026-11-18T09:00:00.000Z', verdict:'blocked', host:'example.test' },
    ], '2026-11-18');
    expect(summary).toMatchObject({ scannedToday:null, blockedToday:null, recentBlocked:[{ host:'example.test' }] });
  });
});
