import { Octokit } from '@octokit/rest';

import { extractPullRequestReferences } from './GitHubPullRequestHeadService';
import { evaluatePullRequestMergeReadiness } from './ProjectsIssueReview';
import { ArtifactReceiptModel, type ArtifactReceiptRow } from '../database/models/ArtifactReceiptModel';
import { WorkItemsModel, type WorkCommentRecord, type WorkTaskRecord } from '../database/models/WorkItemsModel';
import { createGitHubServiceOctokit } from '../tools/github/octokit';

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

export interface ProjectsIssueDetail {
  task:      WorkTaskRecord;
  comments:  WorkCommentRecord[];
  review:    ProjectsIssueReviewBrief;
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
  return createGitHubServiceOctokit('projects-issue-detail');
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
  const [comments, receipts] = await Promise.all([
    WorkItemsModel.listComments(task.id),
    ArtifactReceiptModel.listByTask(task.id),
  ]);
  const evidenceLines = [
    ...comments.flatMap(comment => conciseEvidence(comment.body)),
    ...receiptEvidence(receipts),
  ];

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
  };
}
