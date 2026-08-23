import { Octokit } from '@octokit/rest';

import { isInsideWindow } from './HeartbeatService';
import { getIntegrationService } from './IntegrationService';
import { postgresClient } from '../database/PostgresClient';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { WorkItemsModel } from '../database/models/WorkItemsModel';
import {
  WorkTaskWaitModel,
  type WorkTaskWaitRecord,
  type WaitObservation,
} from '../database/models/WorkTaskWaitModel';

const CHECK_INTERVAL_MS = 60_000;
const DEFAULT_CONCURRENCY = 4;
const MAX_FAILURES = 5;
const FAR_FUTURE_MS = 365 * 24 * 60 * 60 * 1000;

export interface ExternalWaitMonitorMetrics {
  activeWaits:           number;
  checksPerformed:       number;
  unchangedSuppressions: number;
  deltasEmitted:         number;
  failures:              number;
  oldestWait:            string | null;
}

interface GithubTarget {
  owner:       string;
  repo:        string;
  pullNumber?: number;
  ref?:        string;
}

let externalWaitMonitorServiceInstance: ExternalWaitMonitorService | null = null;

export function getExternalWaitMonitorService(): ExternalWaitMonitorService {
  externalWaitMonitorServiceInstance ??= new ExternalWaitMonitorService();
  return externalWaitMonitorServiceInstance;
}

/**
 * Deterministic owner for external waits. Heartbeat sees only the compact wait
 * summary; this service performs bounded polls and writes only material deltas.
 */
export class ExternalWaitMonitorService {
  private initialized = false;
  private checking = false;
  private schedulerId: ReturnType<typeof setInterval> | null = null;
  private metrics = {
    checksPerformed:       0,
    unchangedSuppressions: 0,
    deltasEmitted:         0,
    failures:              0,
  };

  constructor(private readonly githubPoller?: (wait: WorkTaskWaitRecord) => Promise<WaitObservation>) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.bootstrapKnownGithubWaits();
    await this.checkDueWaits();
    this.schedulerId = setInterval(() => {
      this.checkDueWaits().catch(err => console.error('[ExternalWaitMonitor] Scheduled check failed:', err));
    }, CHECK_INTERVAL_MS);
    console.log('[ExternalWaitMonitor] Durable wait monitor initialized');
  }

  destroy(): void {
    this.initialized = false;
    if (this.schedulerId) clearInterval(this.schedulerId);
    this.schedulerId = null;
  }

  async forceCheck(): Promise<void> {
    await this.checkDueWaits(true);
  }

  async getMetrics(): Promise<ExternalWaitMonitorMetrics> {
    const summary = await WorkTaskWaitModel.summary();
    return {
      activeWaits:           summary.active,
      checksPerformed:       this.metrics.checksPerformed,
      unchangedSuppressions: this.metrics.unchangedSuppressions,
      deltasEmitted:         this.metrics.deltasEmitted,
      failures:              Math.max(this.metrics.failures, summary.failures),
      oldestWait:            summary.oldest,
    };
  }

  private async checkDueWaits(force = false): Promise<void> {
    if ((!this.initialized && !force) || this.checking) return;
    this.checking = true;
    try {
      const enabled = await SullaSettingsModel.get('externalWaitMonitorEnabled', true);
      if (!enabled) return;
      const heartbeatEnabled = await SullaSettingsModel.get('heartbeatEnabled', false);
      if (!heartbeatEnabled && !force) return;
      const window = await SullaSettingsModel.get('heartbeatWindow', null);
      if (window && !isInsideWindow(window) && !force) return;

      const configured = Number(await SullaSettingsModel.get('externalWaitMonitorConcurrency', DEFAULT_CONCURRENCY));
      const concurrency = Math.max(1, Math.min(10, configured || DEFAULT_CONCURRENCY));
      const waits = await WorkTaskWaitModel.claimDue(concurrency * 2);
      for (let offset = 0; offset < waits.length; offset += concurrency) {
        await Promise.all(waits.slice(offset, offset + concurrency).map(wait => this.checkWait(wait)));
      }
    } finally {
      this.checking = false;
    }
  }

  private async checkWait(wait: WorkTaskWaitRecord): Promise<void> {
    try {
      let observation: WaitObservation;
      if (wait.wait_kind === 'github_checks') {
        observation = this.githubPoller
          ? await this.githubPoller(wait)
          : await this.pollGithubChecks(wait);
        this.metrics.checksPerformed += 1;
      } else if (wait.wait_kind === 'human_gate') {
        observation = this.checkDueThreshold(wait, 'Human gate due-time reached');
      } else if (wait.wait_kind === 'scheduled_time') {
        observation = this.checkDueThreshold(wait, 'Scheduled wait time reached');
      } else {
        // External jobs require an event-specific adapter. Keeping the row
        // dormant is deliberate: arbitrary model prose never becomes a poll.
        observation = {
          fingerprint: wait.last_observed_fingerprint ?? `external-job:${ wait.target_key }`,
          outcome:     'pending',
          summary:     'External job is awaiting an explicit adapter or event.',
          nextCheckAt: new Date(Date.now() + FAR_FUTURE_MS),
        };
      }

      const result = await WorkTaskWaitModel.observe(wait.id, observation);
      if (!result.changed) {
        this.metrics.unchangedSuppressions += 1;
        return;
      }

      this.metrics.deltasEmitted += 1;
      await WorkItemsModel.addComment({
        task_id: wait.task_id,
        author:  'external-wait-monitor',
        body:    `External wait ${ result.wait?.status ?? observation.outcome }: ${ observation.summary }`,
      });
      console.log(`[ExternalWaitMonitor] Material delta for task ${ wait.task_id }: ${ observation.summary }`);
    } catch (err) {
      this.metrics.failures += 1;
      const message = err instanceof Error ? err.message : String(err);
      const backoffMinutes = Math.min(60, 2 ** Math.min(wait.consecutive_failure_count + 1, 6));
      const result = await WorkTaskWaitModel.recordFailure(
        wait.id, message, new Date(Date.now() + backoffMinutes * 60_000), MAX_FAILURES,
      );
      console.error(`[ExternalWaitMonitor] Check failed for ${ wait.id }; retry in ${ backoffMinutes }m:`, err);
      if (result.terminal) {
        this.metrics.deltasEmitted += 1;
        await WorkItemsModel.addComment({
          task_id: wait.task_id,
          author:  'external-wait-monitor',
          body:    `External wait monitor failed after ${ MAX_FAILURES } attempts: ${ message }. The task was reactivated for recovery; it was not marked blocked.`,
        });
      }
    }
  }

  private checkDueThreshold(wait: WorkTaskWaitRecord, summary: string): WaitObservation {
    const dueMs = wait.due_at ? Date.parse(wait.due_at) : Number.POSITIVE_INFINITY;
    const satisfied = Number.isFinite(dueMs) && dueMs <= Date.now();
    return {
      fingerprint: satisfied ? `due:${ wait.due_at }` : (wait.last_observed_fingerprint ?? `waiting:${ wait.target_key }`),
      outcome:     satisfied ? 'satisfied' : 'pending',
      summary:     satisfied ? summary : 'Event-driven wait remains active.',
      nextCheckAt: satisfied ? new Date() : new Date(Number.isFinite(dueMs) ? dueMs : Date.now() + FAR_FUTURE_MS),
    };
  }

  private async pollGithubChecks(wait: WorkTaskWaitRecord): Promise<WaitObservation> {
    const target = this.parseGithubTarget(wait.target);
    const tokenValue = await getIntegrationService().getIntegrationValue('github', 'token');
    if (!tokenValue) throw new Error('GitHub token not configured in vault');
    const octokit = new Octokit({ auth: tokenValue.value });

    let headSha = target.ref ?? '';
    let prState = 'open';
    if (target.pullNumber) {
      const { data: pr } = await octokit.pulls.get({
        owner: target.owner, repo: target.repo, pull_number: target.pullNumber,
      });
      headSha = pr.head.sha;
      prState = pr.state;
      if (pr.state !== 'open') {
        const fingerprint = WorkTaskWaitModel.fingerprintGithubChecks({ headSha, prState, runs: [] });
        return {
          fingerprint,
          outcome:     'satisfied',
          summary:     `GitHub PR #${ target.pullNumber } is ${ pr.merged ? 'merged' : pr.state } at ${ headSha.slice(0, 8) }.`,
          nextCheckAt: new Date(),
        };
      }
    }
    if (!headSha) throw new Error('GitHub wait target needs pullNumber or ref');

    const { data } = await octokit.checks.listForRef({
      owner: target.owner, repo: target.repo, ref: headSha, per_page: 100,
    });
    const runs = data.check_runs.map(run => ({
      id: run.id, name: run.name, status: run.status, conclusion: run.conclusion,
    }));
    const fingerprint = WorkTaskWaitModel.fingerprintGithubChecks({ headSha, prState, runs });
    const pending = runs.length === 0 || runs.some(run => run.status !== 'completed');
    const failingConclusions = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'stale']);
    const failed = !pending && runs.some(run => failingConclusions.has(run.conclusion ?? ''));
    const outcome = pending ? 'pending' : (failed ? 'failed' : 'satisfied');
    const counts = runs.reduce<Record<string, number>>((acc, run) => {
      const key = run.conclusion || run.status;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    const state = Object.entries(counts).sort().map(([key, count]) => `${ count } ${ key }`).join(', ') || 'no check runs';
    const unchanged = wait.last_observed_fingerprint === fingerprint;
    const backoffMinutes = Math.min(60, 2 * (2 ** Math.min(unchanged ? wait.consecutive_unchanged_count : 0, 5)));
    return {
      fingerprint,
      outcome,
      summary:     `${ target.owner }/${ target.repo }@${ headSha.slice(0, 8) }: ${ state }`,
      nextCheckAt: new Date(Date.now() + backoffMinutes * 60_000),
    };
  }

  private parseGithubTarget(raw: Record<string, unknown>): GithubTarget {
    const owner = typeof raw.owner === 'string' ? raw.owner.trim() : '';
    const repo = typeof raw.repo === 'string' ? raw.repo.trim() : '';
    const pullNumber = typeof raw.pullNumber === 'number'
      ? raw.pullNumber
      : Number.parseInt(String(raw.pullNumber ?? ''), 10) || undefined;
    const ref = typeof raw.ref === 'string' ? raw.ref.trim() : undefined;
    if (!owner || !repo) throw new Error('GitHub wait target needs owner and repo');
    return { owner, repo, pullNumber, ref };
  }

  /**
   * One-time conservative bootstrap. Only recent open tasks with a PR URL and
   * explicit pending-CI wording are converted. Existing comments are retained
   * and no bootstrap comment is added.
   */
  private async bootstrapKnownGithubWaits(): Promise<void> {
    const enabled = await SullaSettingsModel.get('externalWaitMonitorEnabled', true);
    const complete = await SullaSettingsModel.get('externalWaitMonitorBootstrapComplete', false);
    if (!enabled || complete) return;

    const rows = await postgresClient.query<{ task_id: string; body: string }>(`
      SELECT DISTINCT ON (c.task_id) c.task_id, c.body
        FROM work_task_comments c
        JOIN work_tasks t ON t.id = c.task_id
       WHERE c.archived = false AND t.archived = false
         AND t.status NOT IN ('done', 'cancelled', 'parked')
         AND c.body ~* 'github\\.com/[^/]+/[^/]+/pull/[0-9]+'
         AND c.body ~* '(pending|in.progress|waiting).*(ci|check)|(ci|check).*(pending|in.progress|waiting)'
       ORDER BY c.task_id, c.created_at DESC
       LIMIT 100
    `);
    const urlPattern = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i;
    let created = 0;
    for (const row of rows) {
      const match = urlPattern.exec(row.body);
      if (!match) continue;
      const [, owner, repo, number] = match;
      const registration = await WorkTaskWaitModel.register({
        taskId:    row.task_id,
        waitKind:  'github_checks',
        targetKey: `${ owner.toLowerCase() }/${ repo.toLowerCase() }#${ number }`,
        target:    { owner, repo, pullNumber: Number(number) },
      });
      if (registration.created) created += 1;
    }
    await SullaSettingsModel.set('externalWaitMonitorBootstrapComplete', true, 'boolean');
    console.log(`[ExternalWaitMonitor] Bootstrap created ${ created } wait row(s)`);
  }
}
