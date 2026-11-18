// SPDX-License-Identifier: GPL-2.0-or-later
import type { SecurityCheckReport } from './types';

export class SecurityReportLogic {
  header(report: SecurityCheckReport | null): { tone: 'success' | 'warning' | 'neutral'; reason: string; score: string } {
    if (!report) return { tone: 'neutral', reason: '', score: '' };
    const checked = report.checks.filter(check => check.status !== 'not_checked');
    const issue = checked.find(check => check.status === 'fail' || check.status === 'warn');
    return {
      tone: checked.length === 0 ? 'neutral' : issue ? 'warning' : 'success',
      reason: issue?.detail ?? '',
      score: `${report.score.on} of ${report.score.total}`,
    };
  }

  copyText(report: SecurityCheckReport): string {
    const header = this.header(report);
    return [
      `Sulla security check — ${report.finishedAt}`,
      `${header.score} protections on`,
      '',
      ...report.checks.map(check => `[${check.status.toUpperCase()}] ${check.label} — ${check.detail}`),
    ].join('\n');
  }
}
