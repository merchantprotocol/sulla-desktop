import { Octokit } from '@octokit/rest';

import { extractPullRequestReferences } from './GitHubPullRequestHeadService';
import { getIntegrationService } from './IntegrationService';
import { evaluatePullRequestMergeReadiness } from './ProjectsIssueReview';
import { ArtifactReceiptModel, type ArtifactReceiptRow } from '../database/models/ArtifactReceiptModel';
import { WorkItemsModel, type WorkCommentRecord, type WorkTaskRecord } from '../database/models/WorkItemsModel';
import { WorkLaneDefinitionModel } from '../database/models/WorkLaneDefinitionModel';
import { WorkTaskWaitModel } from '../database/models/WorkTaskWaitModel';
import { getProjectsApplicationService } from '../projects/application/ProjectsApplicationService';

export interface ProjectsPullRequestBrief {
  repository:     string;
  number:         number;
  url:            string;
  title:          string;
  state:          string;
  draft:          boolean;
  headSha:        string;
  headRef:        string;
  baseRef:        string;
  mergeable:      boolean | null;
  mergeableState: string;
  checks:         { name: string; status: string; conclusion: string | null; url: string | null }[];
  reviews:        { author: string; state: string; submittedAt: string | null; body: string }[];
  mergeReady:     boolean;
  error?:         string;
}

export interface ProjectsIssueReviewBrief {
  pullRequests:    ProjectsPullRequestBrief[];
  reviewEvidence:  string[];
  documentation:   string[];
  testResults:     string[];
  riskNotes:       string[];
  stagingEvidence: string[];
  rollbackNotes:   string[];
}

export interface ProjectsHumanGateBrief {
  active:        boolean;
  waitIds:       string[];
  currentStage:  string;
  previousStage: string | null;
  nextStage:     string | null;
}

export interface ProjectsIssueDetail {
  task:      WorkTaskRecord;
  comments:  WorkCommentRecord[];
  review:    ProjectsIssueReviewBrief;
  humanGate: ProjectsHumanGateBrief;
}

type OctokitClient = InstanceType<typeof Octokit>;

function conciseEvidence(value: unknown): string[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 40);
}

function matchingNotes(lines: string[], expression: RegExp): string[] {
  return [...new Set(lines.filter(line => expression.test(line)).map(line => line.slice(0, 700)))].slice(0, 8);
}

async function githubClient(): Promise<OctokitClient> {
  const token = await getIntegrationService().getIntegrationValue('github', 'token');
  if (!token) throw new Error('GitHub is not connected in the vault.');
  return new Octokit({ auth: token.value });
}

async function loadPullRequestBriefs(
  task: WorkTaskRecord,
  comments: WorkCommentRecord[],
): Promise<ProjectsPullRequestBrief[]> {
  const references = extractPullRequestReferences(task.github_issue, comments);
  if (!references.length) return [];

  let octokit: OctokitClient;
  try {
    octokit = await githubClient();
  } catch (error: any) {
    return references.map(reference => ({
      repository:     `${ reference.owner }/${ reference.repo }`,
      number:         reference.pullNumber,
      url:            '',
      title:          '',
      state:          'unavailable',
      draft:          false,
      headSha:        '',
      headRef:        '',
      baseRef:        '',
      mergeable:      null,
      mergeableState: 'unknown',
      checks:         [],
      reviews:        [],
      mergeReady:     false,
      error:          error?.message ?? String(error),
    }));
  }

  return Promise.all(references.map(async(reference): Promise<ProjectsPullRequestBrief> => {
    try {
      const { data: pull } = await octokit.pulls.get({
        owner: reference.owner, repo: reference.repo, pull_number: reference.pullNumber,
      });
      const [checksResponse, reviewsResponse] = await Promise.all([
        octokit.checks.listForRef({ owner: reference.owner, repo: reference.repo, ref: pull.head.sha, per_page: 100 }),
        octokit.pulls.listReviews({ owner: reference.owner, repo: reference.repo, pull_number: reference.pullNumber, per_page: 100 }),
      ]);
      const checks = checksResponse.data.check_runs.map(run => ({
        name: run.name, status: run.status, conclusion: run.conclusion ?? null, url: run.html_url ?? null,
      }));
      const reviews = reviewsResponse.data.map(review => ({
        author:      review.user?.login ?? 'unknown',
        state:       review.state,
        submittedAt: review.submitted_at ?? null,
        body:        review.body ?? '',
      }));
      const mergeReady = evaluatePullRequestMergeReadiness({
        state: pull.state, draft: pull.draft === true, mergeable: pull.mergeable, checks, reviews,
      });

      return {
        repository:     `${ reference.owner }/${ reference.repo }`,
        number:         pull.number,
        url:            pull.html_url,
        title:          pull.title,
        state:          pull.merged ? 'merged' : pull.state,
        draft:          pull.draft === true,
        headSha:        pull.head.sha,
        headRef:        pull.head.ref,
        baseRef:        pull.base.ref,
        mergeable:      pull.mergeable,
        mergeableState: pull.mergeable_state,
        checks,
        reviews,
        mergeReady,
      };
    } catch (error: any) {
      return {
        repository:     `${ reference.owner }/${ reference.repo }`,
        number:         reference.pullNumber,
        url:            '',
        title:          '',
        state:          'unavailable',
        draft:          false,
        headSha:        '',
        headRef:        '',
        baseRef:        '',
        mergeable:      null,
        mergeableState: 'unknown',
        checks:         [],
        reviews:        [],
        mergeReady:     false,
        error:          error?.response?.data?.message ?? error?.message ?? String(error),
      };
    }
  }));
}

function receiptEvidence(receipts: ArtifactReceiptRow[]): string[] {
  return receipts.flatMap(receipt => [
    receipt.validation_summary ?? '',
    receipt.disposition ? `Disposition: ${ receipt.disposition }` : '',
    ...conciseEvidence(receipt.artifacts),
  ]).filter(Boolean);
}

export async function loadProjectsIssueDetail(taskId: string): Promise<ProjectsIssueDetail> {
  const task = await WorkItemsModel.getTask(taskId);
  if (!task || task.archived) throw new Error(`Issue ${ taskId } was not found.`);
  const [comments, receipts, waits, lanes] = await Promise.all([
    WorkItemsModel.listComments(task.id),
    ArtifactReceiptModel.listByTask(task.id),
    WorkTaskWaitModel.list({ taskId: task.id, status: 'active' }),
    WorkLaneDefinitionModel.resolveEffective(task.project_id),
  ]);
  const evidenceLines = [
    ...comments.flatMap(comment => conciseEvidence(comment.body)),
    ...receiptEvidence(receipts),
  ];
  const humanWaits = waits.filter(wait => wait.wait_kind === 'human_gate');
  const stageIndex = lanes.findIndex(lane => lane.lane_key === task.status && lane.enabled && !lane.archived);
  const currentLane = stageIndex >= 0 ? lanes[stageIndex] : null;

  return {
    task,
    comments,
    review: {
      pullRequests:    await loadPullRequestBriefs(task, comments),
      reviewEvidence:  receiptEvidence(receipts).slice(0, 12),
      documentation:   matchingNotes(evidenceLines, /\b(documentation|docs?|readme|runbook)\b/i),
      testResults:     matchingNotes(evidenceLines, /\b(test(?:s|ed|ing)?|jest|vitest|playwright|passed|failed)\b/i),
      riskNotes:       matchingNotes(evidenceLines, /\b(risk|regression|security|privacy|tenant|danger)\b/i),
      stagingEvidence: matchingNotes(evidenceLines, /\b(staging|smoke test|acceptance|runtime verification)\b/i),
      rollbackNotes:   matchingNotes(evidenceLines, /\b(rollback|revert|undo|recovery)\b/i),
    },
    humanGate: {
      active:        currentLane?.requires_human_approval === true || humanWaits.length > 0,
      waitIds:       humanWaits.map(wait => wait.id),
      currentStage:  task.status,
      previousStage: stageIndex > 0 ? lanes[stageIndex - 1].lane_key : null,
      nextStage:     stageIndex >= 0 && stageIndex < lanes.length - 1 ? lanes[stageIndex + 1].lane_key : null,
    },
  };
}

export async function decideProjectsHumanGate(
  taskId: string,
  decision: 'approved' | 'rejected',
  reason: string,
  expectedStage: string,
): Promise<ProjectsIssueDetail> {
  const before = await loadProjectsIssueDetail(taskId);
  if (!expectedStage || before.task.status !== expectedStage) {
    throw new Error(`This issue moved from ${ expectedStage || 'an unknown stage' } to ${ before.task.status }. Refresh before deciding.`);
  }
  if (!before.humanGate.active) throw new Error('This issue is not at an active human approval gate.');
  if (decision === 'approved' && !before.humanGate.nextStage) throw new Error('No next pipeline stage is configured.');
  if (decision === 'rejected' && !before.humanGate.previousStage) throw new Error('No previous pipeline stage is configured.');
  const normalizedReason = reason.trim();
  if (decision === 'rejected' && !normalizedReason) throw new Error('A rejection reason is required.');

  const decidedAt = new Date().toISOString();
  const projects = getProjectsApplicationService();
  await projects.transitionTaskRelative({
    taskId,
    direction: decision === 'approved' ? 'next' : 'previous',
  }, { actor: 'human', source: 'ipc' });
  await projects.addComment({
    task_id: taskId,
    author:  'human',
    body:    [
      `Human gate ${ decision }.`,
      'Decision by: human',
      `Recorded at: ${ decidedAt }`,
      normalizedReason ? `Reason: ${ normalizedReason }` : '',
      decision === 'approved'
        ? 'This decision advanced the configured Projects pipeline only. No merge, deployment, payment, or external communication was performed.'
        : 'This decision returned the issue to the previous configured pipeline stage for repair.',
    ].filter(Boolean).join('\n'),
  }, { actor: 'human', source: 'ipc' });
  await Promise.all(before.humanGate.waitIds.map(waitId =>
    WorkTaskWaitModel.cancel(waitId, `Human gate ${ decision } by human at ${ decidedAt }`)));
  return loadProjectsIssueDetail(taskId);
}
