// SPDX-License-Identifier: GPL-2.0-or-later
import type { AgentResultItem } from '@pkg/shared/agentResults/AgentResultCard';

/** Labels reported outcomes, never promotes a finished worker to verified project success. */
export class ResultOutcome {
  static label(item: AgentResultItem): string {
    if (item.status === 'stopped') return 'Stopped';
    if (item.status === 'error') return 'Execution failed';
    if (item.status === 'blocked') return item.purpose === 'qa' ? 'QA incomplete' : 'Reported blocker';
    if (item.merges?.length) return 'Reported merge';
    if (/^CHANGES_REQUESTED$/i.test(item.verdict) || /^Confirm review of #\d+ at head [a-f0-9]{7,40}: CHANGES_REQUESTED\.?$/i.test(item.outcome) || item.findings?.some(finding => finding.severity === 'blocking')) return 'Changes requested';
    if (item.tally?.failed || item.checks?.some(check => !check.passed)) return 'Checks failed';
    if (item.purpose === 'qa' && /^Run\d+ completed with \d+ Pass \/ \d+ Fail \/ [1-9]\d* Blocked\b/.test(item.outcome)) return 'QA incomplete';
    if (item.purpose === 'fix' && /^(?:Fixed and pushed PR #\d+|Updated PR #\d+|Pushed commit [a-f0-9]{7,40})\b/i.test(item.outcome)) return 'Branch updated';
    return item.verdict && !/^(done|completed|finished)$/i.test(item.verdict) ? item.verdict : 'Result returned';
  }

  static time(item: AgentResultItem): number {
    return typeof item.endedAt === 'number' && item.endedAt > 0 && Number.isFinite(new Date(item.endedAt).getTime()) ? item.endedAt : 0;
  }

  static tone(item: AgentResultItem): string {
    const label = this.label(item);
    return /requested|incomplete|blocker|failed/i.test(label) ? 'warning' : 'neutral';
  }
}
