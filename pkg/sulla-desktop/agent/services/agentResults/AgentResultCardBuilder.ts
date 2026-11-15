// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentResultGrounding } from './AgentResultGrounding';

import type {
  AgentResultCardData, AgentResultEnvironment, AgentResultFinding, AgentResultItem, AgentResultPurpose, AgentResultStatus, AgentResultTone,
} from '../../../shared/agentResults/AgentResultCard';
import type { AgentJob, AgentJobResult, AgentJobTask } from '../../tools/agents/jobRegistry';

/** Sends one prompt to a small model and returns its raw text, or null. */
export type ResultClassifierModel = (system: string, user: string, signal: AbortSignal) => Promise<string | null>;

const PURPOSES: AgentResultPurpose[] = ['merge', 'qa', 'review', 'fix', 'other'];
const TONES: AgentResultTone[] = ['ok', 'warn', 'bad', 'info', 'dim'];
const ENV_STATES: AgentResultEnvironment['state'][] = ['deployed', 'failed', 'pending', 'held'];
const SEVERITIES: AgentResultFinding['severity'][] = ['blocking', 'major', 'minor'];
const STATUS_CHIP: Record<AgentResultStatus, { verdict: string; tone: AgentResultTone }> = {
  completed: { verdict: 'Done', tone: 'ok' },
  blocked:   { verdict: 'Blocked', tone: 'warn' },
  error:     { verdict: 'Failed', tone: 'bad' },
  stopped:   { verdict: 'Stopped', tone: 'dim' },
};
const REPORT_LIMIT = 6000;

const SYSTEM = `You turn reports from background software agents into result cards. Reply with JSON only:
{"items":[{"index":0,"purpose":"merge|qa|review|fix|other","verdict":"2-3 word chip","tone":"ok|warn|bad|info|dim","outcome":"one plain sentence",
"merges":[{"pr":"#123","title":"short","sha":"abc1234"}],"environments":[{"name":"Staging","detail":"short","state":"deployed|failed|pending|held"}],
"tally":{"passed":0,"failed":0,"skipped":0},"checks":[{"name":"short","detail":"short","passed":false}],
"findings":[{"severity":"blocking|major|minor","title":"short","detail":"short","file":"path:line"}],
"change":{"pr":"#123","branch":"name","filesChanged":0,"added":0,"removed":0,"files":["path"],"tests":"48/48","ci":"green"},
"next":{"label":"2-4 word button","prompt":"what the user would ask Sulla to do next"}}]}
Purposes: merge = merged PRs or deployed; qa = ran tests or acceptance checks; review = assessed, audited or graded work and gave a verdict;
fix = changed code (a PR or branch); other = anything else. Include only the fields that fit the purpose and only facts stated in the report.
Never invent PR numbers, SHAs, files or numbers. Add an environment only if the report names it. Verdict examples: Merged, 2 failed, Passed,
Changes needed, Approved, PR open, Done. Tone: ok = succeeded, warn = needs the user's attention, bad = failed, info = waiting on review, dim = neutral.
Outcome: one sentence a busy developer reads first; no agent names, no "the agent". next: only when an obvious next step exists; it is only
drafted for the user, never run. Omit next for anything risky the report says is not ready.`;

/**
 * Builds the finished-agent card. Status, timing and the plain outcome come
 * from the job itself; a small model only classifies the purpose and pulls
 * the purpose-specific fields out of the report, then every identifier it
 * returns is grounded against the report text. If the model is missing,
 * slow or wrong, the plain card is used as is.
 */
export class AgentResultCardBuilder {
  constructor(
    private readonly model: ResultClassifierModel | undefined,
    private readonly timeoutMs = 5000,
    private readonly grounding = new AgentResultGrounding(),
  ) {}

  async build(job: AgentJob, results: AgentJobResult[], taskIndex = 0): Promise<AgentResultCardData> {
    const items = results.map((result, index) => this.base(job, result, this.task(job, result, index, results.length, taskIndex)));
    const enriched = await this.classify(items).catch(() => undefined);

    return { items: (enriched ?? items).map(item => this.grounding.ground(item)) };
  }

  private task(job: AgentJob, result: AgentJobResult, index: number, count: number, taskIndex: number): { task?: AgentJobTask; index: number } {
    const byThread = result.threadId ? job.tasks.findIndex(task => task.threadId === result.threadId) : -1;
    if (byThread >= 0) return { task: job.tasks[byThread], index: byThread };
    const position = count === 1 && taskIndex >= 0 ? taskIndex : index;
    return { task: job.tasks[position], index: position };
  }

  private base(job: AgentJob, result: AgentJobResult, { task, index }: { task?: AgentJobTask; index: number }): AgentResultItem {
    const status = result.status;
    const started = task?.startedAt ?? job.createdAt;
    const ended = task?.finishedAt ?? task?.returnedAt ?? job.finishedAt;
    const report = String(result.output ?? '').trim();

    return {
      jobId:      job.jobId,
      taskIndex:  index,
      label:      result.label || task?.label || 'Background agent',
      agentId:    task?.agentId || undefined,
      threadId:   result.threadId || task?.threadId || undefined,
      durationMs: started && ended && ended > started ? ended - started : undefined,
      status,
      purpose:    'other',
      ...STATUS_CHIP[status],
      outcome:    this.firstSentence(report) || `${ STATUS_CHIP[status].verdict }.`,
      report,
    };
  }

  private async classify(items: AgentResultItem[]): Promise<AgentResultItem[] | undefined> {
    if (!this.model || !items.some(item => item.report)) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const user = items.map((item, index) => `### index ${ index } · ${ item.label } [${ item.status }]\n${ item.report.slice(0, REPORT_LIMIT) }`).join('\n\n');
      const raw = await Promise.race([
        this.model(SYSTEM, user, controller.signal),
        new Promise<null>(resolve => controller.signal.addEventListener('abort', () => resolve(null), { once: true })),
      ]);
      const parsed = raw ? this.parse(raw) : undefined;
      if (!parsed) return undefined;

      return items.map((item, index) => this.merge(item, parsed.find(entry => entry?.index === index)));
    } finally {
      clearTimeout(timer);
    }
  }

  private parse(raw: string): any[] | undefined {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
      const value = JSON.parse(raw.slice(start, end + 1));
      return Array.isArray(value?.items) ? value.items : undefined;
    } catch {
      return undefined;
    }
  }

  /** Keep only well-formed fields; the job's own status always decides failure. */
  private merge(item: AgentResultItem, entry: any): AgentResultItem {
    if (!entry || typeof entry !== 'object') return item;
    const text = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);
    const count = (value: unknown) => (Number.isInteger(value) && (value as number) >= 0 && (value as number) < 1_000_000 ? value as number : undefined);
    const list = <T>(value: unknown, max: number, map: (entry: any) => T | undefined) => (Array.isArray(value)
      ? value.slice(0, max).map(map).filter((entry): entry is T => entry !== undefined)
      : undefined);
    const nonEmpty = <T>(value: T[] | undefined) => (value?.length ? value : undefined);
    const purpose = PURPOSES.includes(entry.purpose) ? entry.purpose as AgentResultPurpose : item.purpose;
    const modelTone = TONES.includes(entry.tone) ? entry.tone as AgentResultTone : item.tone;
    const succeeded = item.status === 'completed';
    const tally = entry.tally && typeof entry.tally === 'object'
      ? { passed: count(entry.tally.passed), failed: count(entry.tally.failed), skipped: count(entry.tally.skipped) }
      : undefined;
    const change = entry.change && typeof entry.change === 'object'
      ? {
        pr:           text(entry.change.pr, 12),
        branch:       text(entry.change.branch, 120),
        filesChanged: count(entry.change.filesChanged),
        added:        count(entry.change.added),
        removed:      count(entry.change.removed),
        files:        nonEmpty(list(entry.change.files, 8, file => text(file, 200))),
        tests:        text(entry.change.tests, 40),
        ci:           text(entry.change.ci, 40),
      }
      : undefined;
    const next = text(entry.next?.label, 32) && text(entry.next?.prompt, 400)
      ? { label: text(entry.next.label, 32)!, prompt: text(entry.next.prompt, 400)! }
      : undefined;

    return {
      ...item,
      purpose,
      verdict:      (succeeded && text(entry.verdict, 28)) || item.verdict,
      tone:         succeeded ? modelTone : item.tone,
      outcome:      text(entry.outcome, 280) ?? item.outcome,
      merges:       nonEmpty(list(entry.merges, 40, merge => (text(merge?.pr, 12) ? { pr: text(merge.pr, 12)!, title: text(merge.title, 120), sha: text(merge.sha, 40) } : undefined))),
      environments: nonEmpty(list(entry.environments, 6, env => (text(env?.name, 40) && ENV_STATES.includes(env.state)
        ? { name: text(env.name, 40)!, detail: text(env.detail, 120), state: env.state }
        : undefined))),
      tally:        tally && Object.values(tally).some(value => value !== undefined) ? tally : undefined,
      checks:       nonEmpty(list(entry.checks, 30, check => (text(check?.name, 120) && typeof check.passed === 'boolean'
        ? { name: text(check.name, 120)!, detail: text(check.detail, 200), passed: check.passed }
        : undefined))),
      findings:     nonEmpty(list(entry.findings, 30, finding => (text(finding?.title, 120) && SEVERITIES.includes(finding.severity)
        ? { severity: finding.severity, title: text(finding.title, 120)!, detail: text(finding.detail, 200), file: text(finding.file, 200) }
        : undefined))),
      change:       change && Object.values(change).some(value => value !== undefined) ? change : undefined,
      next:         succeeded ? next : undefined,
    };
  }

  private firstSentence(report: string): string {
    const line = report.split('\n').map(part => part.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) ?? '';
    const sentence = /^(.{20,260}?[.!?])(\s|$)/.exec(line)?.[1] ?? line;
    return sentence.length > 260 ? `${ sentence.slice(0, 257) }…` : sentence;
  }
}

/** The production model: the Subconscious (cheap, fast) routing slot. */
export const subconsciousResultModel: ResultClassifierModel = async(system, user, signal) => {
  const { getSubconsciousService } = await import('../../languagemodels/index');
  const llm = await getSubconsciousService();
  if (!llm) return null;
  const providerId = llm.getProviderId();
  const accountId = await llm.getAccountId();
  const executionContext = providerId && accountId
    ? await (await import('../../languagemodels/providerBroker')).issueServiceProviderExecutionContext('agent-result-card', providerId, accountId, signal)
    : undefined;
  const response = await llm.chat([{ role: 'system', content: system }, { role: 'user', content: user }], {
    maxTokens: 1200, temperature: 0, format: 'json', signal, timeoutSeconds: 5, conversationId: 'agent-result-card', executionContext,
  });

  return response?.content ?? null;
};
