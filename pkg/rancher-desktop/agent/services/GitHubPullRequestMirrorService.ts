import { createHash } from 'node:crypto';

import { Octokit } from '@octokit/rest';

import type { GitHubPullRequestDisposition, GitHubPullRequestMirrorRecord } from '../database/models/GitHubPullRequestMirrorModel';
import type { UpdateTaskInput, UpsertTaskInput, WorkEpicRecord, WorkTaskRecord } from '../database/models/WorkItemsModel';
import type { ProjectsCommandContext } from '../projects/application/ProjectsApplicationService';

export interface PullRequestMirrorRepository { owner: string; repo: string }
export interface PullRequestMirrorInput {
  repositories:   PullRequestMirrorRepository[];
  epicId:         string;
  parentId:       string | null;
  openStatus:     string;
  terminalStatus: string;
  actor:          string;
  dryRun:         boolean;
  batchSize:      number;
}
export interface PullRequestMirrorFailure { repository: string; pullNumber?: number; error: string }
export interface PullRequestMirrorResult {
  configurationFingerprint: string;
  dryRun:                   boolean;
  discovered:               number;
  processed:                number;
  created:                  number;
  updated:                  number;
  unchanged:                number;
  terminalized:             number;
  reopened:                 number;
  merged:                   number;
  closed:                   number;
  duplicates:               string[];
  failures:                 PullRequestMirrorFailure[];
  startedAt:                string;
  completedAt:              string;
}

type PullRequest = Awaited<ReturnType<Octokit['pulls']['get']>>['data'];
type Review = Awaited<ReturnType<Octokit['pulls']['listReviews']>>['data'][number];
type CheckRun = Awaited<ReturnType<Octokit['checks']['listForRef']>>['data']['check_runs'][number];

interface ProjectsPort {
  ready(): Promise<unknown>;
  getEpic(id: string): Promise<WorkEpicRecord | null>;
  getTask(id: string): Promise<WorkTaskRecord | null>;
  resolveEffectiveLanes(projectId: string): Promise<{ lane_key: string; archived: boolean; enabled: boolean }[]>;
  listTasks(input: { epicId: string; includeDone: boolean; limit: number }): Promise<WorkTaskRecord[]>;
  createTask(input: UpsertTaskInput, context?: ProjectsCommandContext): Promise<WorkTaskRecord>;
  updateTask(id: string, changes: UpdateTaskInput, context?: ProjectsCommandContext): Promise<WorkTaskRecord | null>;
  addComment(input: { id?: string; task_id: string; body: string; author?: string }, context?: ProjectsCommandContext): Promise<unknown>;
}

export interface PullRequestMirrorStore {
  claim(input: { owner: string; repository: string; pullNumber: number; projectId: string; epicId: string; parentId: string | null }): Promise<GitHubPullRequestMirrorRecord>;
  listForScope(projectId: string, epicId: string): Promise<GitHubPullRequestMirrorRecord[]>;
  recordSnapshot(input: { owner: string; repository: string; pullNumber: number; taskId: string; fingerprint: string; remoteUpdatedAt: string; disposition: GitHubPullRequestDisposition }): Promise<void>;
  recordError(owner: string, repository: string, pullNumber: number, message: string): Promise<void>;
}

const SOURCE_PREFIX = 'github-pr:';
const MIRROR_LABELS = ['github-pr-mirror', 'pr-review'];
const BLOCK_START = '<!-- sulla:github-pr-mirror -->';
const BLOCK_END = '<!-- /sulla:github-pr-mirror -->';

export function mirrorIdentity(owner: string, repo: string, pullNumber: number): string {
  return `${ owner.trim().toLowerCase() }/${ repo.trim().toLowerCase() }#${ pullNumber }`;
}
function sourceRef(owner: string, repo: string, pullNumber: number): string {
  return `${ SOURCE_PREFIX }${ mirrorIdentity(owner, repo, pullNumber) }`;
}
function identityFromTask(task: WorkTaskRecord): string | null {
  if (task.source_ref?.startsWith(SOURCE_PREFIX)) return task.source_ref.slice(SOURCE_PREFIX.length).toLowerCase();
  const match = task.github_issue?.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i);
  return match ? mirrorIdentity(match[1], match[2], Number(match[3])) : null;
}
function reviewState(pr: PullRequest, reviews: Review[]): string {
  if (pr.draft) return 'draft';
  const latest = new Map<string, string>();
  for (const review of reviews) if (review.user?.login && review.state !== 'PENDING') latest.set(review.user.login.toLowerCase(), review.state.toLowerCase());
  const states = [...latest.values()];
  if (states.includes('changes_requested')) return 'changes_requested';
  if (states.includes('approved')) return 'approved';
  if (states.length) return 'reviewed';
  if ((pr.requested_reviewers?.length ?? 0) > 0 || (pr.requested_teams?.length ?? 0) > 0) return 'review_requested';
  return 'review_required';
}
function checkState(checks: CheckRun[]): string {
  if (!checks.length) return 'none';
  if (checks.some(check => check.status !== 'completed')) return 'pending';
  const conclusions = checks.map(check => check.conclusion);
  if (conclusions.some(value => ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(value ?? ''))) return 'failure';
  if (conclusions.every(value => ['success', 'neutral', 'skipped'].includes(value ?? ''))) return 'success';
  return 'unknown';
}
function dispositionFor(pr: PullRequest): GitHubPullRequestDisposition {
  return pr.merged ? 'merged' : pr.state === 'closed' ? 'closed_unmerged' : 'open';
}
function snapshotFor(pr: PullRequest, repository: PullRequestMirrorRepository, checks: CheckRun[], reviews: Review[]) {
  const snapshot = {
    identity:       mirrorIdentity(repository.owner, repository.repo, pr.number),
    repository:     `${ repository.owner }/${ repository.repo }`,
    number:         pr.number,
    url:            pr.html_url,
    title:          pr.title,
    body:           pr.body ?? '',
    author:         pr.user?.login ?? 'unknown',
    draft:          Boolean(pr.draft),
    headSha:        pr.head.sha.toLowerCase(),
    baseSha:        pr.base.sha.toLowerCase(),
    checkState:     checkState(checks),
    checkCount:     checks.length,
    reviewState:    reviewState(pr, reviews),
    mergeable:      pr.mergeable === null ? 'unknown' : String(pr.mergeable),
    mergeableState: pr.mergeable_state ?? 'unknown',
    disposition:    dispositionFor(pr),
    updatedAt:      pr.updated_at,
  };
  return { snapshot, fingerprint: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
}
function renderDescription(existing: string | undefined, snapshot: ReturnType<typeof snapshotFor>['snapshot'], fingerprint: string): string {
  const block = [BLOCK_START, `GitHub identity: ${ snapshot.identity }`, `Repository: ${ snapshot.repository }`,
    `Pull request: #${ snapshot.number }`, `URL: ${ snapshot.url }`, `Author: ${ snapshot.author }`, `Draft: ${ snapshot.draft }`,
    `Head SHA: ${ snapshot.headSha }`, `Base SHA: ${ snapshot.baseSha }`,
    `Check state: ${ snapshot.checkState } (${ snapshot.checkCount } check${ snapshot.checkCount === 1 ? '' : 's' })`,
    `Review state: ${ snapshot.reviewState }`, `Mergeability: ${ snapshot.mergeable } (${ snapshot.mergeableState })`,
    `GitHub disposition: ${ snapshot.disposition }`, `GitHub updated: ${ snapshot.updatedAt }`,
    `Snapshot fingerprint: ${ fingerprint }`, '', snapshot.body.trim() || '_No GitHub description._', BLOCK_END].join('\n');
  const current = existing ?? '';
  const start = current.indexOf(BLOCK_START);
  const end = current.indexOf(BLOCK_END);
  if (start >= 0 && end >= start) return `${ current.slice(0, start) }${ block }${ current.slice(end + BLOCK_END.length) }`;
  return current.trim() ? `${ block }\n\n${ current.trim() }` : block;
}
function desiredStatus(pr: PullRequest, existing: WorkTaskRecord | undefined, openStatus: string, terminalStatus: string): string | undefined {
  if (pr.merged || pr.state === 'closed') return terminalStatus;
  if (!existing || existing.status === terminalStatus) return openStatus;
  return undefined;
}
function changed(existing: WorkTaskRecord, values: Record<string, unknown>): boolean {
  return Object.entries(values).some(([key, value]) => value !== undefined && JSON.stringify((existing as any)[key]) !== JSON.stringify(value));
}
function headFromDescription(description: string | undefined): string | null {
  return description?.match(/^Head SHA: ([a-f0-9]+)$/im)?.[1]?.toLowerCase() ?? null;
}
function lifecycleComment(pr: PullRequest, existing: WorkTaskRecord | undefined, previousHead: string | null, terminalStatus: string): string | null {
  const head = pr.head.sha.toLowerCase();
  if (!existing) return `Mirror created from GitHub at head ${ head }.`;
  if (pr.merged && existing.status !== terminalStatus) return `GitHub reports this pull request merged at head ${ head }; mirror moved to ${ terminalStatus }.`;
  if (pr.state === 'closed' && !pr.merged && existing.status !== terminalStatus) return `GitHub reports this pull request closed without merge; mirror moved to ${ terminalStatus }.`;
  if (pr.state === 'open' && existing.status === terminalStatus) return 'GitHub reports this pull request reopened; mirror returned to the configured intake stage.';
  if (previousHead && previousHead !== head) return `GitHub head changed from ${ previousHead } to ${ head }; metadata resynchronized without resetting its stage.`;
  return null;
}

function lifecycleCommentId(identity: string, body: string): string {
  return `gpm-${ createHash('sha256').update(`${ identity }:${ body }`).digest('hex').slice(0, 24) }`;
}

export class GitHubPullRequestMirrorService {
  constructor(private readonly github: Octokit, private readonly projects: ProjectsPort, private readonly store: PullRequestMirrorStore) {}

  async reconcile(input: PullRequestMirrorInput): Promise<PullRequestMirrorResult> {
    const startedAt = new Date().toISOString();
    await this.projects.ready();
    const epic = await this.projects.getEpic(input.epicId);
    if (!epic || epic.archived) throw new Error(`Destination epic ${ input.epicId } is missing or archived.`);
    if (input.parentId) {
      const parent = await this.projects.getTask(input.parentId);
      if (!parent || parent.archived || parent.project_id !== epic.project_id || parent.epic_id !== epic.id) throw new Error(`Destination parent ${ input.parentId } must be active in epic ${ epic.id }.`);
    }
    const laneKeys = new Set((await this.projects.resolveEffectiveLanes(epic.project_id)).filter(lane => lane.enabled && !lane.archived).map(lane => lane.lane_key));
    for (const status of [input.openStatus, input.terminalStatus]) if (!laneKeys.has(status)) throw new Error(`Destination project ${ epic.project_id } has no active '${ status }' stage.`);
    const configurationFingerprint = createHash('sha256').update(JSON.stringify({
      repositories:   input.repositories.map(repo => ({ owner: repo.owner.toLowerCase(), repo: repo.repo.toLowerCase() })).sort((a, b) => `${ a.owner }/${ a.repo }`.localeCompare(`${ b.owner }/${ b.repo }`)),
      projectId:      epic.project_id,
      epicId:         epic.id,
      parentId:       input.parentId,
      openStatus:     input.openStatus,
      terminalStatus: input.terminalStatus,
    })).digest('hex');
    const result: PullRequestMirrorResult = {
      configurationFingerprint,
      dryRun:       input.dryRun,
      discovered:   0,
      processed:    0,
      created:      0,
      updated:      0,
      unchanged:    0,
      terminalized: 0,
      reopened:     0,
      merged:       0,
      closed:       0,
      duplicates:   [],
      failures:     [],
      startedAt,
      completedAt:  startedAt,
    };
    const existingTasks = await this.projects.listTasks({ epicId: input.epicId, includeDone: true, limit: 5000 });
    const grouped = new Map<string, WorkTaskRecord[]>();
    for (const task of existingTasks) { const key = identityFromTask(task); if (key) grouped.set(key, [...(grouped.get(key) ?? []), task]); }
    result.duplicates = [...grouped.entries()].filter(([, tasks]) => tasks.length > 1).map(([key]) => key);
    const existingByIdentity = new Map([...grouped.entries()].map(([key, tasks]) => [key, tasks.sort((a, b) => a.created_at.localeCompare(b.created_at))[0]]));
    const targets = new Map<string, { repository: PullRequestMirrorRepository; pullNumber: number }>();
    for (const repository of input.repositories) {
      try {
        const prs = await this.github.paginate(this.github.pulls.list, { owner: repository.owner, repo: repository.repo, state: 'open', per_page: 100 });
        for (const pr of prs) targets.set(mirrorIdentity(repository.owner, repository.repo, pr.number), { repository, pullNumber: pr.number });
      } catch (error: any) { result.failures.push({ repository: `${ repository.owner }/${ repository.repo }`, error: error?.message ?? String(error) }) }
    }
    for (const mapping of await this.store.listForScope(epic.project_id, epic.id)) {
      const repository = input.repositories.find(value => value.owner.toLowerCase() === mapping.owner && value.repo.toLowerCase() === mapping.repository);
      if (repository) targets.set(mirrorIdentity(mapping.owner, mapping.repository, mapping.pull_number), { repository, pullNumber: mapping.pull_number });
    }
    for (const key of existingByIdentity.keys()) {
      const match = /^([^/]+)\/(.+)#(\d+)$/.exec(key);
      const repository = match && input.repositories.find(value => value.owner.toLowerCase() === match[1] && value.repo.toLowerCase() === match[2]);
      if (match && repository) targets.set(key, { repository, pullNumber: Number(match[3]) });
    }
    result.discovered = targets.size;
    for (const [key, target] of [...targets].slice(0, input.batchSize)) {
      try {
        const [{ data: pr }, reviews] = await Promise.all([
          this.github.pulls.get({ owner: target.repository.owner, repo: target.repository.repo, pull_number: target.pullNumber }),
          this.github.paginate(this.github.pulls.listReviews, { owner: target.repository.owner, repo: target.repository.repo, pull_number: target.pullNumber, per_page: 100 }),
        ]);
        const { data: checks } = await this.github.checks.listForRef({ owner: target.repository.owner, repo: target.repository.repo, ref: pr.head.sha, per_page: 100 });
        const existing = existingByIdentity.get(key);
        const { snapshot, fingerprint } = snapshotFor(pr, target.repository, checks.check_runs, reviews);
        const status = desiredStatus(pr, existing, input.openStatus, input.terminalStatus);
        // Repository classification is installation policy, not product logic.
        const labels = [...new Set([...(existing?.labels ?? []), ...MIRROR_LABELS])];
        const values: Record<string, unknown> = {
          title:        `Review PR #${ pr.number } — ${ pr.title }`,
          description:  renderDescription(existing?.description, snapshot, fingerprint),
          github_issue: pr.html_url,
          labels,
          source:       'github-pr-mirror',
          source_ref:   sourceRef(target.repository.owner, target.repository.repo, pr.number),
          status,
        };
        const comment = lifecycleComment(pr, existing, headFromDescription(existing?.description), input.terminalStatus);
        let task = existing;
        if (!input.dryRun) await this.store.claim({ owner: target.repository.owner, repository: target.repository.repo, pullNumber: pr.number, projectId: epic.project_id, epicId: epic.id, parentId: input.parentId });
        if (!existing) {
          if (input.dryRun) {
            result.created++;
          } else {
            try {
              task = await this.projects.createTask({
                ...values,
                title:      values.title as string,
                project_id: epic.project_id,
                epic_id:    epic.id,
                parent_id:  input.parentId,
                priority:   'high',
                assignee:   'human',
                actor:      input.actor,
              }, { actor: input.actor, source: 'routine' });
              result.created++;
            } catch (error: any) {
              if (error?.code !== '23505') throw error;
              task = (await this.projects.listTasks({ epicId: input.epicId, includeDone: true, limit: 5000 }))
                .find(candidate => identityFromTask(candidate) === key);
              if (!task) throw error;
              result.unchanged++;
            }
          }
        } else if (changed(existing, values)) {
          result.updated++;
          if (status === input.terminalStatus && existing.status !== input.terminalStatus) result.terminalized++;
          if (status === input.openStatus && existing.status === input.terminalStatus) result.reopened++;
          if (!input.dryRun) task = await this.projects.updateTask(existing.id, { ...values, actor: input.actor } as UpdateTaskInput, { actor: input.actor, source: 'routine' }) ?? existing;
        } else result.unchanged++;
        if (!input.dryRun && task) {
          if (comment) {
            try {
              await this.projects.addComment({
                id: lifecycleCommentId(key, comment), task_id: task.id, body: comment, author: input.actor,
              }, { actor: input.actor, source: 'routine' });
            } catch (error: any) {
              if (error?.code !== '23505') throw error;
            }
          }
          await this.store.recordSnapshot({
            owner:           target.repository.owner,
            repository:      target.repository.repo,
            pullNumber:      pr.number,
            taskId:          task.id,
            fingerprint,
            remoteUpdatedAt: pr.updated_at,
            disposition:     dispositionFor(pr),
          });
        }
        if (pr.merged) result.merged++; else if (pr.state === 'closed') result.closed++;
        result.processed++;
      } catch (error: any) {
        const message = error?.message ?? String(error);
        result.failures.push({ repository: `${ target.repository.owner }/${ target.repository.repo }`, pullNumber: target.pullNumber, error: message });
        if (!input.dryRun) await this.store.recordError(target.repository.owner, target.repository.repo, target.pullNumber, message).catch(() => undefined);
      }
    }
    result.completedAt = new Date().toISOString();
    return result;
  }
}
