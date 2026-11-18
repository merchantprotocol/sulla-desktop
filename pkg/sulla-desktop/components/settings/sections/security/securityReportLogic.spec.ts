// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { SecurityReportLogic } from './securityReportLogic';
import type { SecurityCheckReport } from './types';

const report: SecurityCheckReport = {
  startedAt: '2026-11-18T10:00:00.000Z',
  finishedAt: '2026-11-18T10:00:05.000Z',
  checks: [
    { id: 'runtime', label: 'Runtime', status: 'pass', detail: 'Contained' },
    { id: 'blocklist', label: 'Blocklist', status: 'warn', detail: 'Refresh is overdue' },
    { id: 'vault', label: 'Vault', status: 'not_checked', detail: 'Not available' },
  ],
  score: { on: 1, total: 2 },
};

describe('SecurityReportLogic', () => {
  it('uses report score and first warning reason for the header', () => {
    const state = new SecurityReportLogic().header(report);
    expect(state).toEqual({ tone: 'warning', reason: 'Refresh is overdue', score: '1 of 2' });
  });

  it('does not call a report protected when no checks were performed', () => {
    const noChecks = { ...report, checks: [{ id: 'vault' as const, label: 'Vault', status: 'not_checked' as const, detail: 'Unavailable' }], score: { on: 0, total: 0 } };
    expect(new SecurityReportLogic().header(noChecks).tone).toBe('neutral');
  });

  it('formats a plain text report and preserves non-pass statuses', () => {
    const text = new SecurityReportLogic().copyText(report);
    expect(text).toContain('Sulla security check — 2026-11-18T10:00:05.000Z\n1 of 2 protections on');
    expect(text).toContain('[WARN] Blocklist — Refresh is overdue');
    expect(text).toContain('[NOT_CHECKED] Vault — Not available');
  });
});
