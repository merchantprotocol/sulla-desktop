// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Text notices saved before finished-agent result cards existed:
 * "Background agents finished — 0 done, 1 blocked, 0 failed, 0 stopped" plus
 * 'Task "X" is ready. Check `check_agent_jobs("agent-job-…")`…'. Read the
 * status, task and job back out of that text so the old notice can be shown
 * as one compact line, or hidden when a result card covers the same job.
 */
export interface LegacyAgentNotice {
  verdict: string;
  tone:    'ok' | 'warn' | 'bad' | 'dim';
  label:   string;
  jobId?:  string;
}

export function parseLegacyAgentNotice(headline: string, body: string): LegacyAgentNotice | undefined {
  if (!/^Background agents? (finished|failed|stopped)/i.test(headline)) return undefined;
  const jobId = /\b(agent-job-[\w-]+)/.exec(body)?.[1];
  const label = /Task "([^"]+)"/.exec(body)?.[1] ?? /Tasks: (.+?)\.\s*Check/.exec(body)?.[1] ?? 'Background agents';

  if (/^Background agents? failed/i.test(headline)) return { verdict: 'Failed', tone: 'bad', label, jobId };
  if (/^Background agents? stopped/i.test(headline)) return { verdict: 'Stopped', tone: 'dim', label, jobId };

  const count = (word: string) => Number(new RegExp(`(\\d+) ${ word }`).exec(headline)?.[1] ?? 0);
  if (count('failed')) return { verdict: 'Failed', tone: 'bad', label, jobId };
  if (count('blocked')) return { verdict: 'Blocked', tone: 'warn', label, jobId };
  if (count('stopped')) return { verdict: 'Stopped', tone: 'dim', label, jobId };

  return { verdict: 'Done', tone: 'ok', label, jobId };
}
