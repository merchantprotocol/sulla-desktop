// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { FilesListingPager } from '@pkg/agent/files/FilesListingPager';
import { getSullaFilesClient, type SullaFilesClient } from '../sullaFilesClient';
import {
  inspectGuestStorageCandidate,
  removeGuestStorageCandidate,
  scanGuestStorage,
  STORAGE_GUEST_ROOTS,
  type GuestCandidateRef,
  type GuestDeleteResult,
  type GuestRepositoryState,
  type GuestStorageCandidate,
  type GuestStorageScan,
} from './StorageCleanupGuest';

import { agentJobProvider } from '@pkg/agent/app/Providers/AgentJobServiceProvider';
import { postgresClient } from '@pkg/agent/database/PostgresClient';
import { snapshotAgentContainerRuntimes } from '@pkg/agent/services/AgentContainerRuntimeRegistry';
import type { AgentJob, AgentJobTask } from '@pkg/agent/tools/agents/jobRegistry';
import { createGitHubServiceOctokit } from '@pkg/agent/tools/github/octokit';
import paths from '@pkg/utils/paths';

const PLAN_TTL_MS = 5 * 60_000;
const MAX_PLAN_TARGETS = 100;
const MAX_REMOTE_REFS = 500;
const MAX_REMOTE_COMPARISONS = 250;

export type StorageCleanupAssessment = 'eligible' | 'protected' | 'blocked' | 'unknown';

export interface StorageCleanupAssociation {
  kind:  'project' | 'chat';
  id:    string;
  label: string;
}

export interface StorageCleanupProject {
  id:            string;
  label:         string;
  path:          string;
  projectFileId: string;
  collectionId:  string;
}

export interface StorageCleanupRemoteEvidence {
  repository:      string;
  localCommitSha:  string;
  remoteRef:       string;
  remoteCommitSha: string;
}

export interface StorageCleanupTarget {
  id:                        string;
  displayName:               string;
  repositoryName:            string;
  branchLabel:               string;
  path:                      string;
  workspaceRoot:             string;
  source:                    GuestStorageCandidate['source'];
  location:                  'Sulla VM';
  allocatedBytes:            number | null;
  recoverableBytes:          number | null;
  estimatedRecoverableBytes: number | null;
  lastActivityAt:            string | null;
  measurement:               'measured' | 'scan-error';
  assessment:                StorageCleanupAssessment;
  reasonCode:                string;
  reason:                    string;
  selectable:                boolean;
  associations:              StorageCleanupAssociation[];
  identity:                  GuestStorageCandidate['identity'];
  repository:                GuestRepositoryState;
  remoteEvidence:            StorageCleanupRemoteEvidence[];
  revision:                  string;
}

export interface StorageCleanupInventory {
  generatedAt:        string;
  status:             'ready' | 'blocked';
  targets:            StorageCleanupTarget[];
  projects:           StorageCleanupProject[];
  allocatedBytes:     number | null;
  /** Sum of the targets that were measured; reported with unmeasuredCount, never as a complete total. */
  measuredAllocatedBytes: number;
  unmeasuredCount:    number;
  eligibleBytes:      number | null;
  scanErrors:         string[];
  authorityAvailable: boolean;
  runtimeAvailable:   boolean;
  accounting: {
    guest: string;
    host:  string;
  };
}

export interface StorageCleanupPlanTarget {
  id:             string;
  displayName:    string;
  path:           string;
  workspaceRoot:  string;
  source:         GuestStorageCandidate['source'];
  allocatedBytes: number;
  recoverableBytes: number;
  revision:       string;
  identity:       GuestStorageCandidate['identity'];
  gitFingerprint: string;
  ownership:      string;
  remoteEvidence: StorageCleanupRemoteEvidence[];
}

export interface StorageCleanupPlan {
  id:                        string;
  createdAt:                 string;
  expiresAt:                 string;
  selectedTargetIds:         string[];
  targets:                   StorageCleanupPlanTarget[];
  blocked:                   { id: string; displayName: string; path?: string; reason: string }[];
  estimatedRecoverableBytes: number;
}

export interface StorageCleanupTargetReceipt {
  id:                       string;
  path:                     string;
  status:                   'pending' | 'removed' | 'partial' | 'blocked' | 'failed';
  reason?:                  string;
  removedBytes:             number;
  guestFreeSpaceDeltaBytes: number | null;
}

export interface StorageCleanupReceipt {
  operationId:              string;
  planId:                   string;
  status:                   'executing' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'expired' | 'interrupted';
  startedAt:                string;
  finishedAt?:              string;
  targets:                  StorageCleanupTargetReceipt[];
  removedBytes:             number;
  guestFreeSpaceDeltaBytes: number;
  hostRecovery: {
    status: 'not-measured';
    note:   string;
  };
  replayed?: boolean;
}

interface AuthorityConversation {
  id:           string;
  threadId:     string;
  channelId:    string;
  title:        string;
  lastActiveAt: string | null;
  metadata:     Record<string, unknown>;
}

interface AuthorityProjectTask {
  taskId:       string;
  projectId:    string;
  projectTitle: string;
}

interface AuthorityFileReference {
  conversationId: string;
  fileId:         string;
  path:           string;
  versionId:      string;
  name:           string;
}

interface AuthoritySnapshot {
  jobs:            AgentJob[];
  conversations:   AuthorityConversation[];
  projectTasks:    AuthorityProjectTask[];
  filesProjects:   StorageCleanupProject[];
  fileReferences:  AuthorityFileReference[];
  runtimeReady:    boolean;
  runtimeBindings: { jobId: string; threadId?: string; workspacePath: string }[];
}

export interface RemoteReachabilityResult {
  status:   'verified' | 'unknown';
  evidence: StorageCleanupRemoteEvidence[];
  reason?:  string;
}

export interface StorageCleanupReceiptStore {
  get(planId:string):Promise<StorageCleanupReceipt | undefined>;
  save(receipt:StorageCleanupReceipt):Promise<void>;
}

export interface StorageCleanupDependencies {
  scanGuest():Promise<GuestStorageScan>;
  /** Re-inspects one reviewed target without rescanning the whole guest. */
  inspectGuest(ref:GuestCandidateRef):Promise<GuestStorageCandidate>;
  removeGuest(request:Parameters<typeof removeGuestStorageCandidate>[0]):Promise<GuestDeleteResult>;
  authority():Promise<AuthoritySnapshot>;
  prove(repository:GuestRepositoryState):Promise<RemoteReachabilityResult>;
  receipts: StorageCleanupReceiptStore;
  now():Date;
  randomId():string;
}

interface GitHubRepository {
  owner: string;
  repo:  string;
}

interface CurrentRemoteRef {
  repository: string;
  ref:        string;
  commitSha:  string;
}

function canonicalJson(value:unknown):string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${ value.map(canonicalJson).join(',') }]`;
  const record = value as Record<string, unknown>;
  return `{${ Object.keys(record).sort().filter(key => record[key] !== undefined)
    .map(key => `${ JSON.stringify(key) }:${ canonicalJson(record[key]) }`).join(',') }}`;
}

function digest(value:unknown):string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function asRecord(value:unknown):Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boundedGuestPath(candidate:string):boolean {
  return [STORAGE_GUEST_ROOTS.agents, STORAGE_GUEST_ROOTS.conversations]
    .some(root => candidate === root || candidate.startsWith(`${ root }/`));
}

function sameOrChild(candidate:string, root:string):boolean {
  return candidate === root || candidate.startsWith(`${ root }/`);
}

function parseGitHubRemote(value:string):GitHubRepository | undefined {
  const https = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(value);
  const ssh = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value);
  const match = https ?? ssh;
  if (!match || match[1].startsWith('.') || match[2].startsWith('.')) return undefined;
  return { owner: match[1], repo: match[2] };
}

function sanitizeSensitiveText(value:string):string {
  return value
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '[redacted URL]')
    .replace(/\b[^\s/@]+@[A-Za-z0-9.-]+:[^\s"'<>]+/g, '[redacted remote]');
}

function publicRemoteUrl(value:string):string {
  const repository = parseGitHubRemote(value);
  if (!repository) return '[unsupported or credentialed remote redacted]';
  return value.startsWith('git@github.com:')
    ? `git@github.com:${ repository.owner }/${ repository.repo }.git`
    : `https://github.com/${ repository.owner }/${ repository.repo }.git`;
}

function publicRepositoryState(repository:GuestRepositoryState):GuestRepositoryState {
  return {
    ...repository,
    remoteUrls: [...new Set(repository.remoteUrls.map(publicRemoteUrl))],
    ...(repository.error ? { error: sanitizeSensitiveText(repository.error) } : {}),
  };
}

interface FilesCollectionRecord {
  id:             string;
  kind?:          string;
  agent_run_id?:  string | null;
  system_area?:   string | null;
  systemArea?:    string | null;
  published?:     boolean;
  legacy_source?: boolean;
}

interface FilesProjectRecord {
  id:             string;
  collection_id?: string;
  path:           string;
}

/** Authenticated Files catalog adapter. It reads paths and IDs only, never project document content. */
export async function readFilesProjects(client:Pick<SullaFilesClient, 'json' | 'request'> = getSullaFilesClient()):Promise<StorageCleanupProject[]> {
  const collections = await client.json<FilesCollectionRecord[]>('/v1/collections');
  const projects = new Map<string, StorageCleanupProject>();
  for (const collection of collections.filter(item =>
    item.kind === 'knowledge' && !item.agent_run_id && (item.systemArea ?? item.system_area ?? null) === null &&
    item.published !== false && item.legacy_source !== true)) {
    let rows = 0;
    for await (const page of FilesListingPager.pages<FilesProjectRecord>(
      endpoint => client.request(endpoint), '/v1/files', { collectionId: collection.id, path: 'Projects', trash: 'false' }, 100,
    )) {
      rows += page.length;
      if (rows > 5_000) throw new Error('Files project catalog exceeded the bounded metadata scan');
      for (const file of page) {
        const match = /^Projects\/([^/]+)\/PROJECT\.md$/.exec(file.path);
        if (!match) continue;
        const id = `files:${ collection.id }:${ match[1] }`;
        projects.set(id, {
          id,
          label:         match[1],
          path:          `Projects/${ match[1] }`,
          projectFileId: file.id,
          collectionId:  file.collection_id ?? collection.id,
        });
      }
    }
  }
  return [...projects.values()].sort((left, right) => left.label.localeCompare(right.label));
}

async function dereferenceRemoteObject(octokit:any, repository:GitHubRepository, object:any):Promise<string | undefined> {
  let current = object;
  for (let depth = 0; depth < 5; depth++) {
    if (current?.type === 'commit' && typeof current.sha === 'string') return current.sha;
    if (current?.type !== 'tag' || typeof current.sha !== 'string') return undefined;
    const response = await octokit.rest.git.getTag({ ...repository, tag_sha: current.sha });
    current = response.data.object;
  }
  return undefined;
}

async function currentGitHubRefs(octokit:any, repository:GitHubRepository):Promise<CurrentRemoteRef[]> {
  const result:CurrentRemoteRef[] = [];
  for (const prefix of ['heads/', 'tags/']) {
    const responses = await octokit.paginate(octokit.rest.git.listMatchingRefs, { ...repository, ref: prefix, per_page: 100 });
    if (responses.length + result.length > MAX_REMOTE_REFS) throw new Error('GitHub repository has too many refs for a bounded cleanup proof');
    for (const item of responses) {
      const commitSha = await dereferenceRemoteObject(octokit, repository, item.object);
      if (!commitSha || typeof item.ref !== 'string') continue;
      result.push({ repository: `${ repository.owner }/${ repository.repo }`, ref: item.ref, commitSha });
    }
  }
  return result;
}

export async function proveGitHubReachabilityWithOctokit(repository:GuestRepositoryState, octokit:any):Promise<RemoteReachabilityResult> {
  const parsed = repository.remoteUrls.map(parseGitHubRemote);
  if (parsed.length === 0 || parsed.some(item => !item)) {
    return { status: 'unknown', evidence: [], reason: 'A canonical GitHub HTTPS or SSH remote could not be verified' };
  }
  const repositories = Array.from(new Map(parsed.map(item => [`${ item!.owner }/${ item!.repo }`, item!])).values());
  const commits = new Set<string>([
    ...repository.localBranches.map(item => item.commitSha),
    ...repository.localTags.map(item => item.commitSha),
    ...(repository.extraRefs ?? []).map(item => item.commitSha),
    ...repository.reflogOnlyCommits,
  ]);
  if (repository.detached && repository.headSha) commits.add(repository.headSha);
  if (commits.size === 0) return { status: 'unknown', evidence: [], reason: 'No local commit was available to prove' };

  try {
    const refs = (await Promise.all(repositories.map(item => currentGitHubRefs(octokit, item)))).flat();
    if (refs.length === 0) return { status: 'unknown', evidence: [], reason: 'GitHub reported no current branch or tag refs' };
    const evidence:StorageCleanupRemoteEvidence[] = [];
    let comparisons = 0;
    for (const localCommitSha of commits) {
      let match = refs.find(item => item.commitSha === localCommitSha);
      if (!match) {
        const preferredNames = new Set([
          ...repository.localBranches.filter(item => item.commitSha === localCommitSha).map(item => `refs/heads/${ item.name }`),
          ...repository.localTags.filter(item => item.commitSha === localCommitSha).map(item => `refs/tags/${ item.name }`),
          ...(repository.extraRefs ?? []).filter(item => item.commitSha === localCommitSha)
            .map(item => item.name.replace(/^refs\/remotes\/[^/]+\//, 'refs/heads/')),
        ]);
        const ordered = [...refs].sort((left, right) => Number(preferredNames.has(right.ref)) - Number(preferredNames.has(left.ref)));
        for (const remote of ordered) {
          if (++comparisons > MAX_REMOTE_COMPARISONS) {
            return { status: 'unknown', evidence: [], reason: 'Remote reachability exceeded the bounded comparison budget' };
          }
          const [owner, repo] = remote.repository.split('/');
          try {
            const response = await octokit.rest.repos.compareCommits({ owner, repo, base: localCommitSha, head: remote.commitSha });
            if (response.data.status === 'ahead' || response.data.status === 'identical') {
              match = remote;
              break;
            }
          } catch (error:any) {
            const status = Number(error?.status ?? 0);
            if (status === 401 || status === 403 || status >= 500 || status === 0) throw error;
          }
        }
      }
      if (!match) {
        return { status: 'unknown', evidence: [], reason: `Local commit ${ localCommitSha.slice(0, 12) } is not reachable from a current GitHub branch or tag` };
      }
      evidence.push({
        repository:      match.repository,
        localCommitSha,
        remoteRef:       match.ref,
        remoteCommitSha: match.commitSha,
      });
    }
    return { status: 'verified', evidence };
  } catch (error) {
    return { status: 'unknown', evidence: [], reason: sanitizeSensitiveText(`GitHub reachability is unavailable: ${ (error as Error)?.message ?? error }`) };
  }
}

export async function proveGitHubReachability(repository:GuestRepositoryState):Promise<RemoteReachabilityResult> {
  try {
    return await proveGitHubReachabilityWithOctokit(repository, await createGitHubServiceOctokit('storage-cleanup'));
  } catch (error) {
    return { status: 'unknown', evidence: [], reason: sanitizeSensitiveText(`GitHub reachability is unavailable: ${ (error as Error)?.message ?? error }`) };
  }
}

async function readAuthority():Promise<AuthoritySnapshot> {
  const [jobs, database, filesProjects] = await Promise.all([
    agentJobProvider.jobs.allJobs(),
    postgresClient.transaction(async(client) => {
      const [conversationRows, projectRows, referenceRows] = await Promise.all([
        client.query(`SELECT id, thread_id, channel_id, title, last_active_at, thread_state
          FROM conversation_history WHERE type = 'chat' AND deleted_at IS NULL`),
        client.query(`SELECT task.id AS task_id, project.id AS project_id, project.title AS project_title
          FROM work_tasks task JOIN work_projects project ON project.id = task.project_id`),
        client.query(`SELECT message.conversation_id,
            reference.value->'fileRef'->>'fileId' AS file_id,
            reference.value->'fileRef'->>'path' AS path,
            reference.value->'fileRef'->>'versionId' AS version_id,
            reference.value->'fileRef'->>'name' AS name
          FROM conversation_messages message
          CROSS JOIN LATERAL jsonb_array_elements(CASE
            WHEN jsonb_typeof(message.payload->'fileReferences') = 'array' THEN message.payload->'fileReferences'
            ELSE '[]'::jsonb END) reference(value)
          WHERE message.deleted_at IS NULL AND reference.value ? 'fileRef'
          LIMIT 5000`),
      ]);
      return { conversations: conversationRows.rows, projectTasks: projectRows.rows, fileReferences: referenceRows.rows };
    }),
    readFilesProjects(),
  ]);
  const runtime = snapshotAgentContainerRuntimes();
  return {
    jobs,
    conversations: database.conversations.map(row => ({
      id:           String(row.id),
      threadId:     String(row.thread_id || row.id),
      channelId:    String(row.channel_id || ''),
      title:        String(row.title || 'Untitled chat'),
      lastActiveAt: row.last_active_at ? new Date(row.last_active_at).toISOString() : null,
      metadata:     asRecord(asRecord(row.thread_state).metadata),
    })),
    projectTasks: database.projectTasks.map(row => ({
      taskId: String(row.task_id), projectId: String(row.project_id), projectTitle: String(row.project_title),
    })),
    filesProjects,
    fileReferences: database.fileReferences.map(row => ({
      conversationId: String(row.conversation_id),
      fileId:         String(row.file_id ?? ''),
      path:           String(row.path ?? ''),
      versionId:      String(row.version_id ?? ''),
      name:           String(row.name ?? ''),
    })).filter(item => item.fileId || item.path),
    runtimeReady:    runtime.ready,
    runtimeBindings: runtime.bindings.map(binding => ({
      jobId: binding.jobId, threadId: binding.threadId, workspacePath: binding.workspacePath,
    })),
  };
}

export class JsonStorageCleanupReceiptStore implements StorageCleanupReceiptStore {
  private serial: Promise<void> = Promise.resolve();
  constructor(private readonly file = path.join(paths.appHome, 'storage-cleanup', 'receipts.json')) {}

  private async read():Promise<Record<string, StorageCleanupReceipt>> {
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8')) as Record<string, StorageCleanupReceipt>;
    } catch (error:any) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
  }

  async get(planId:string):Promise<StorageCleanupReceipt | undefined> {
    await this.serial;
    return (await this.read())[planId];
  }

  async save(receipt:StorageCleanupReceipt):Promise<void> {
    const operation = this.serial.then(async() => {
      const receipts = await this.read();
      receipts[receipt.planId] = structuredClone(receipt);
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const next = `${ this.file }.next`;
      await fs.writeFile(next, `${ JSON.stringify(receipts, null, 2) }\n`, { mode: 0o600 });
      await fs.rename(next, this.file);
    });
    this.serial = operation.catch(() => undefined);
    await operation;
  }
}

export class MemoryStorageCleanupReceiptStore implements StorageCleanupReceiptStore {
  readonly values = new Map<string, StorageCleanupReceipt>();
  get(planId:string):Promise<StorageCleanupReceipt | undefined> {
    const value = this.values.get(planId);
    return Promise.resolve(value ? structuredClone(value) : undefined);
  }

  save(receipt:StorageCleanupReceipt):Promise<void> {
    this.values.set(receipt.planId, structuredClone(receipt));
    return Promise.resolve();
  }
}

function defaultDependencies():StorageCleanupDependencies {
  return {
    scanGuest:    () => scanGuestStorage(),
    inspectGuest: ref => inspectGuestStorageCandidate(ref),
    removeGuest:  request => removeGuestStorageCandidate(request),
    authority:    readAuthority,
    prove:        proveGitHubReachability,
    receipts:     new JsonStorageCleanupReceiptStore(),
    now:          () => new Date(),
    randomId:     () => crypto.randomUUID(),
  };
}

function cleanupReceipts(job:AgentJob, task:AgentJobTask) {
  // Persisted result slots stay null until their task finishes.
  return [task.completion?.cleanupReceipt, ...job.results.map(result => result?.cleanupReceipt)];
}

function explicitWorkspacePaths(job:AgentJob, task:AgentJobTask):string[] {
  const paths = [task.workspacePath];
  for (const receipt of cleanupReceipts(job, task)) paths.push(receipt?.recoveryWorkspacePath, ...(receipt?.retainedGuestPaths ?? []));
  return Array.from(new Set(paths.filter((value):value is string => typeof value === 'string' && boundedGuestPath(value))));
}

function activeTask(job:AgentJob, task:AgentJobTask):boolean {
  return ['running', 'parked'].includes(job.status) && ['queued', 'running', 'parked', 'blocked'].includes(task.status);
}

/** Recovery paths come from the same receipts that establish ownership: the task's and the job's. */
function recoveryPaths(job:AgentJob, task:AgentJobTask):string[] {
  return cleanupReceipts(job, task).flatMap(receipt => [receipt?.recoveryWorkspacePath, ...(receipt?.retainedGuestPaths ?? [])])
    .filter((value):value is string => typeof value === 'string' && boundedGuestPath(value));
}

function persistenceHash(conversation:AuthorityConversation):string {
  const delegated = conversation.metadata.containerPersistenceKey;
  const key = typeof delegated === 'string' && delegated.trim()
    ? delegated
    : `conversation:${ conversation.channelId }:${ conversation.threadId }`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
}

function targetId(candidate:GuestCandidateRef):string {
  return digest({ source: candidate.source, path: candidate.path, workspaceRoot: candidate.workspaceRoot });
}

function targetIdentity(candidate:GuestStorageCandidate):{ displayName: string; repositoryName: string; branchLabel: string } {
  const remote = candidate.repository.remoteUrls.map(parseGitHubRemote).find(Boolean);
  const repositoryName = remote ? `${ remote.owner }/${ remote.repo }` : path.posix.basename(candidate.path);
  const branchCount = candidate.repository.counts?.localBranches ?? candidate.repository.localBranches.length;
  const branchLabel = candidate.repository.detached
    ? `detached @ ${ candidate.repository.headSha?.slice(0, 12) ?? 'unknown' }`
    : candidate.repository.currentBranch ?? (branchCount === 1
      ? candidate.repository.localBranches[0].name
      : `${ branchCount } local branches`);
  return { repositoryName, branchLabel, displayName: `${ repositoryName } · ${ branchLabel }` };
}

interface AssessmentContext {
  authority?:      AuthoritySnapshot;
  authorityError?: string;
  taskProjects:    Map<string, AuthorityProjectTask>;
  conversationsByHash: Map<string, AuthorityConversation>;
  filesProjects:   StorageCleanupProject[];
  fileProjectIdsByConversation: Map<string, Set<string>>;
  runtimePaths:    Set<string>;
  activeThreads:   Set<string>;
  activePaths:     Set<string>;
  recoverablePaths: Set<string>;
  ownership:       Map<string, { projectTaskIds: Set<string>; threadIds: Set<string> }>;
}

function assessmentContext(authority:AuthoritySnapshot | undefined, authorityError:string | undefined):AssessmentContext {
  const filesProjects = authority?.filesProjects ?? [];
  const fileProjectIdsByConversation = new Map<string, Set<string>>();
  for (const reference of authority?.fileReferences ?? []) {
    const normalizedPath = reference.path.replace(/^\/mnt\/sulla-files\//, '').replace(/^\/+/, '');
    const project = filesProjects.find(item => item.projectFileId === reference.fileId ||
      normalizedPath === item.path || normalizedPath.startsWith(`${ item.path }/`));
    if (!project) continue;
    const ids = fileProjectIdsByConversation.get(reference.conversationId) ?? new Set<string>();
    ids.add(project.id);
    fileProjectIdsByConversation.set(reference.conversationId, ids);
  }
  const context:AssessmentContext = {
    authority,
    authorityError,
    taskProjects:        new Map((authority?.projectTasks ?? []).map(item => [item.taskId, item])),
    conversationsByHash: new Map((authority?.conversations ?? []).map(item => [persistenceHash(item), item])),
    filesProjects,
    fileProjectIdsByConversation,
    runtimePaths:        new Set((authority?.runtimeBindings ?? []).map(item => item.workspacePath).filter(boundedGuestPath)),
    activeThreads:       new Set<string>(),
    activePaths:         new Set<string>(),
    recoverablePaths:    new Set<string>(),
    ownership:           new Map(),
  };
  for (const job of authority?.jobs ?? []) {
    const jobProjects = new Set(job.projectTaskIds ?? []);
    for (const task of job.tasks) {
      const projects = new Set([...jobProjects, ...(task.taskId ? [task.taskId] : [])]);
      const threads = new Set([job.parentThreadId, task.threadId].filter((value):value is string => Boolean(value)));
      for (const workspace of explicitWorkspacePaths(job, task)) {
        const owner = context.ownership.get(workspace) ?? { projectTaskIds: new Set<string>(), threadIds: new Set<string>() };
        projects.forEach(value => owner.projectTaskIds.add(value));
        threads.forEach(value => owner.threadIds.add(value));
        context.ownership.set(workspace, owner);
        if (activeTask(job, task)) context.activePaths.add(workspace);
      }
      recoveryPaths(job, task).forEach(workspace => context.recoverablePaths.add(workspace));
      if (activeTask(job, task)) threads.forEach(value => context.activeThreads.add(value));
    }
  }
  return context;
}

function sanitizedReason(value:unknown):string {
  return sanitizeSensitiveText(String((value as Error)?.message ?? value ?? '')).slice(0, 1000);
}

const REVISION_NOTE = 'Workspace changed since review';

export class StorageCleanupService {
  private readonly plans = new Map<string, StorageCleanupPlan>();
  private readonly operations = new Map<string, Promise<StorageCleanupReceipt>>();
  private preparedPlanId?: string;
  constructor(private readonly dependencies:StorageCleanupDependencies = defaultDependencies()) {}

  private async context():Promise<AssessmentContext> {
    try {
      return assessmentContext(await this.dependencies.authority(), undefined);
    } catch (error) {
      return assessmentContext(undefined, `Ownership database is unavailable: ${ (error as Error)?.message ?? error }`);
    }
  }

  private async assess(candidate:GuestStorageCandidate, context:AssessmentContext):Promise<StorageCleanupTarget> {
    const { authority } = context;
    const associations:StorageCleanupAssociation[] = [];
    const projectIds = new Set<string>();
    const threadIds = new Set<string>();
    let ownerKnown = false;
    for (const [workspace, owner] of context.ownership) {
      if (sameOrChild(candidate.path, workspace) || sameOrChild(workspace, candidate.workspaceRoot)) {
        ownerKnown = true;
        owner.projectTaskIds.forEach(value => projectIds.add(value));
        owner.threadIds.forEach(value => threadIds.add(value));
      }
    }
    const conversation = candidate.persistenceKeyHash ? context.conversationsByHash.get(candidate.persistenceKeyHash) : undefined;
    if (conversation) {
      ownerKnown = true;
      threadIds.add(conversation.threadId);
    }
    for (const taskId of projectIds) {
      const project = context.taskProjects.get(taskId);
      if (project && !associations.some(item => item.kind === 'project' && item.id === project.projectId)) {
        associations.push({ kind: 'project', id: project.projectId, label: project.projectTitle });
      }
    }
    for (const threadId of threadIds) {
      const chat = (authority?.conversations ?? []).find(item => item.threadId === threadId || item.id === threadId);
      if (chat && !associations.some(item => item.kind === 'chat' && item.id === chat.threadId)) {
        associations.push({ kind: 'chat', id: chat.threadId, label: chat.title });
      }
      if (chat) {
        for (const projectId of context.fileProjectIdsByConversation.get(chat.id) ?? []) {
          const project = context.filesProjects.find(item => item.id === projectId);
          if (project && !associations.some(item => item.kind === 'project' && item.id === project.id)) {
            associations.push({ kind: 'project', id: project.id, label: project.label });
          }
        }
      }
    }

    const repository = candidate.repository;
    const count = (key:keyof GuestRepositoryState) => repository.counts?.[key] ?? (repository[key] as unknown as unknown[] | undefined)?.length ?? 0;
    let assessment:StorageCleanupAssessment = 'eligible';
    let reasonCode = 'remote-verified-inactive';
    let reason = 'Inactive code is fully represented by current GitHub branch or tag refs.';
    let remoteEvidence:StorageCleanupRemoteEvidence[] = [];
    const pathActive = [...context.activePaths, ...context.runtimePaths].some(workspace => sameOrChild(candidate.path, workspace) || sameOrChild(workspace, candidate.workspaceRoot));
    const pathRecoverable = [...context.recoverablePaths].some(workspace => sameOrChild(candidate.path, workspace) || sameOrChild(workspace, candidate.workspaceRoot));
    const descendantActive = candidate.source === 'conversation-child' && [...threadIds].some(thread => context.activeThreads.has(thread));
    if (!authority) {
      assessment = 'unknown'; reasonCode = 'authority-unavailable'; reason = context.authorityError!;
    } else if (!authority.runtimeReady) {
      assessment = 'unknown'; reasonCode = 'runtime-inventory-pending'; reason = 'Container runtime inventory is not ready; open work is protected.';
    } else if (pathActive || descendantActive) {
      assessment = 'protected'; reasonCode = 'active-owner'; reason = 'An active, queued, paused, parked, descendant, or open runtime owns this workspace subtree.';
    } else if (pathRecoverable) {
      assessment = 'protected'; reasonCode = 'recovery-owner'; reason = 'A retained recovery receipt still owns this workspace subtree.';
    } else if (!ownerKnown) {
      assessment = 'unknown'; reasonCode = 'unlinked'; reason = 'No authoritative project or chat linkage exists; unlinked work is retained.';
    } else if (count('worktreeMetadata')) {
      assessment = 'blocked'; reasonCode = 'shared-git-metadata'; reason = 'This repository owns or depends on shared Git worktree metadata and is retained in this release.';
    } else if (candidate.unsafeSymlinks.length || candidate.specialFiles.length || candidate.mountPoints?.length || candidate.identity.realPath !== candidate.path) {
      assessment = 'blocked'; reasonCode = 'unsafe-filesystem'; reason = 'Symlinks, special files, mounted or cross-device entries, or a non-canonical path prevent safe removal.';
    } else if (count('nestedRepositories') || count('submodules')) {
      assessment = 'blocked'; reasonCode = 'nested-repository'; reason = 'Nested repositories or submodules are retained because their ownership is independent.';
    } else if (count('localScripts')) {
      assessment = 'blocked'; reasonCode = 'local-git-scripts'; reason = 'Local Git hooks or script configuration exist only in this checkout and are retained.';
    } else if (count('dirtyEntries')) {
      assessment = 'blocked'; reasonCode = 'local-changes'; reason = 'Tracked or untracked local changes are not published and will not be removed.';
    } else if (count('ignoredEntries')) {
      assessment = 'blocked'; reasonCode = 'ignored-files'; reason = 'Ignored files are present and are retained in this release.';
    } else if (count('stashCommits')) {
      assessment = 'blocked'; reasonCode = 'local-stash'; reason = 'Local stash history is retained and cannot be treated as published source.';
    } else if (count('unreachableObjects')) {
      assessment = 'blocked'; reasonCode = 'lost-local-history'; reason = 'Unreachable Git objects may contain lost local history and are retained.';
    } else if (count('unsupportedRefs')) {
      assessment = 'blocked'; reasonCode = 'unsupported-refs'; reason = 'Replacement or non-commit Git refs cannot be proven against GitHub and are retained.';
    } else if (candidate.scanError || repository.error || candidate.contentVerified === false) {
      assessment = 'unknown'; reasonCode = 'scan-error'; reason = candidate.scanError ?? repository.error ?? 'Workspace content was not verified.';
    } else {
      const proof = await this.dependencies.prove(repository);
      if (proof.status !== 'verified') {
        assessment = 'unknown'; reasonCode = 'remote-proof-unavailable'; reason = proof.reason ?? 'Current remote refs could not be verified.';
      } else {
        remoteEvidence = proof.evidence;
      }
    }
    reason = sanitizeSensitiveText(reason);
    const revision = digest({ identity: candidate.identity, git: repository.fingerprint, allocatedBytes: candidate.allocatedBytes, remoteEvidence, associations });
    const recoverableBytes = candidate.recoverableBytes ?? null;
    return {
      id:                        targetId(candidate),
      ...targetIdentity(candidate),
      path:                      candidate.path,
      workspaceRoot:             candidate.workspaceRoot,
      source:                    candidate.source,
      location:                  'Sulla VM',
      allocatedBytes:            candidate.allocatedBytes,
      recoverableBytes,
      estimatedRecoverableBytes: assessment === 'eligible' ? recoverableBytes : 0,
      lastActivityAt:            conversation?.lastActiveAt ?? candidate.lastActivityAt,
      measurement:               candidate.allocatedBytes === null ? 'scan-error' : 'measured',
      assessment,
      reasonCode,
      reason,
      selectable:                assessment === 'eligible' && candidate.allocatedBytes !== null && recoverableBytes !== null,
      associations,
      identity:                  candidate.identity,
      repository:                publicRepositoryState(repository),
      remoteEvidence,
      revision,
    };
  }

  async inventory():Promise<StorageCleanupInventory> {
    let scan:GuestStorageScan;
    try {
      scan = await this.dependencies.scanGuest();
    } catch (error) {
      return {
        generatedAt:            this.dependencies.now().toISOString(),
        status:                 'blocked',
        targets:                [],
        projects:               [],
        allocatedBytes:         null,
        measuredAllocatedBytes: 0,
        unmeasuredCount:        0,
        eligibleBytes:          null,
        scanErrors:             [sanitizeSensitiveText(`Guest runtime inventory failed: ${ (error as Error)?.message ?? error }`)],
        authorityAvailable:     false,
        runtimeAvailable:       false,
        accounting:             {
          guest: 'No guest measurement is available because the scan failed.',
          host:  'Host recovery is not inferred from guest deletion; VM trim or sparse-image compaction may occur later.',
        },
      };
    }
    const context = await this.context();
    const targets:StorageCleanupTarget[] = [];
    for (const candidate of scan.candidates) targets.push(await this.assess(candidate, context));
    const unmeasuredCount = targets.filter(item => item.allocatedBytes === null).length;
    const measurable = unmeasuredCount === 0 && scan.errors.length === 0;
    const measuredAllocatedBytes = targets.reduce((sum, item) => sum + (item.allocatedBytes ?? 0), 0);
    return {
      generatedAt:            this.dependencies.now().toISOString(),
      status:                 scan.errors.length || context.authorityError || !context.authority?.runtimeReady ? 'blocked' : 'ready',
      targets:                targets.sort((left, right) => (right.allocatedBytes ?? -1) - (left.allocatedBytes ?? -1)),
      projects:               context.filesProjects,
      allocatedBytes:         measurable ? measuredAllocatedBytes : null,
      measuredAllocatedBytes,
      unmeasuredCount,
      eligibleBytes:          targets.reduce((sum, item) => sum + (item.selectable ? item.recoverableBytes ?? 0 : 0), 0),
      scanErrors:             [...scan.errors, ...(context.authorityError ? [context.authorityError] : [])].map(sanitizeSensitiveText),
      authorityAvailable:     Boolean(context.authority),
      runtimeAvailable:       context.authority?.runtimeReady === true,
      accounting:             {
        guest: 'Allocated bytes are measured inside the Sulla VM. Recoverable estimates exclude hard-linked data that also lives outside the checkout. A completed receipt records measured guest free-space change.',
        host:  'Host recovery is not inferred from guest deletion; VM trim or sparse-image compaction may occur later.',
      },
    };
  }

  async plan(input:{ targetIds: string[] }):Promise<StorageCleanupPlan> {
    const selectedTargetIds = Array.from(new Set((input?.targetIds ?? []).filter(value => typeof value === 'string')));
    if (selectedTargetIds.length === 0) throw new Error('Select at least one eligible workspace');
    if (selectedTargetIds.length > MAX_PLAN_TARGETS) throw new Error(`Select no more than ${ MAX_PLAN_TARGETS } workspaces at once`);
    const inventory = await this.inventory();
    const byId = new Map(inventory.targets.map(item => [item.id, item]));
    const targets:StorageCleanupPlanTarget[] = [];
    const blocked:StorageCleanupPlan['blocked'] = [];
    for (const id of selectedTargetIds) {
      const target = byId.get(id);
      if (!target?.selectable || target.allocatedBytes === null || target.recoverableBytes === null) {
        blocked.push({
          id,
          displayName: target?.displayName ?? id,
          path:        target?.path,
          reason:      target?.reason ?? 'Target is no longer present in the guest inventory',
        });
        continue;
      }
      targets.push({
        id,
        displayName:      target.displayName,
        path:             target.path,
        workspaceRoot:    target.workspaceRoot,
        source:           target.source,
        allocatedBytes:   target.allocatedBytes,
        recoverableBytes: target.recoverableBytes,
        revision:         target.revision,
        identity:         structuredClone(target.identity),
        gitFingerprint:   target.repository.fingerprint,
        ownership:        digest(target.associations),
        remoteEvidence:   structuredClone(target.remoteEvidence),
      });
    }
    if (targets.length === 0) throw new Error(blocked[0]?.reason ?? 'No selected workspace remains eligible');
    const now = this.dependencies.now();
    const plan:StorageCleanupPlan = {
      id:                        this.dependencies.randomId(),
      createdAt:                 now.toISOString(),
      expiresAt:                 new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
      selectedTargetIds,
      targets,
      blocked,
      estimatedRecoverableBytes: targets.reduce((sum, item) => sum + item.recoverableBytes, 0),
    };
    this.plans.set(plan.id, structuredClone(plan));
    return structuredClone(plan);
  }

  async preparePreview(input:{ targetIds: string[] }):Promise<StorageCleanupPlan> {
    const plan = await this.plan(input);
    this.preparedPlanId = plan.id;
    return plan;
  }

  takePreparedPreview():StorageCleanupPlan | undefined {
    const planId = this.preparedPlanId;
    this.preparedPlanId = undefined;
    if (!planId) return undefined;
    try {
      return this.review(planId);
    } catch {
      return undefined;
    }
  }

  review(planId:string):StorageCleanupPlan {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error('Cleanup review plan was not found; refresh and review again');
    if (this.dependencies.now().getTime() >= new Date(plan.expiresAt).getTime()) throw new Error('Cleanup review plan expired; refresh and review again');
    return structuredClone(plan);
  }

  /** One operation per plan: a cancel or replay never overwrites or races an execution's receipt. */
  private once(planId:string, operation:() => Promise<StorageCleanupReceipt>):Promise<StorageCleanupReceipt> {
    const current = this.operations.get(planId);
    if (current) return current.then(receipt => ({ ...structuredClone(receipt), replayed: true }));
    const started = (async() => {
      const previous = await this.dependencies.receipts.get(planId);
      if (previous) return { ...previous, status: previous.status === 'executing' ? 'interrupted' as const : previous.status, replayed: true };
      return operation();
    })();
    this.operations.set(planId, started);
    started.finally(() => {
      if (this.operations.get(planId) === started) this.operations.delete(planId);
    }).catch(() => undefined);
    return started;
  }

  cancel(planId:string):Promise<StorageCleanupReceipt> {
    return this.once(planId, async() => {
      const plan = this.review(planId);
      const now = this.dependencies.now().toISOString();
      const receipt:StorageCleanupReceipt = {
        operationId:              this.dependencies.randomId(),
        planId,
        status:                   'cancelled',
        startedAt:                now,
        finishedAt:               now,
        targets:                  plan.targets.map(item => ({ id: item.id, path: item.path, status: 'blocked', reason: 'Cancelled before removal', removedBytes: 0, guestFreeSpaceDeltaBytes: null })),
        removedBytes:             0,
        guestFreeSpaceDeltaBytes: 0,
        hostRecovery:             { status: 'not-measured', note: 'No removal occurred. Host disk recovery was not measured.' },
      };
      await this.dependencies.receipts.save(receipt);
      return receipt;
    });
  }

  execute(planId:string):Promise<StorageCleanupReceipt> {
    return this.once(planId, () => this.executeOnce(planId));
  }

  /** Fresh single-target inspection, ownership and current-ref proof; never a whole-guest rescan. */
  private async revalidate(planned:StorageCleanupPlanTarget):Promise<string | undefined> {
    const candidate = await this.dependencies.inspectGuest({
      path:          planned.path,
      workspaceRoot: planned.workspaceRoot,
      source:        planned.source,
      ...(planned.source === 'conversation-child' ? { persistenceKeyHash: planned.workspaceRoot.split('/').at(-2) } : {}),
    });
    const target = await this.assess(candidate, await this.context());
    if (target.id !== planned.id || target.path !== planned.path) return `${ REVISION_NOTE }: the reviewed path no longer matches`;
    if (digest(target.identity) !== digest(planned.identity)) return `${ REVISION_NOTE }: its files or directory identity changed`;
    if (target.repository.fingerprint !== planned.gitFingerprint) return `${ REVISION_NOTE }: its Git refs, history or working tree changed`;
    if (!target.selectable) return `No longer eligible: ${ target.reason }`;
    if (digest(target.associations) !== planned.ownership) return `${ REVISION_NOTE }: its project or chat ownership changed`;
    return undefined;
  }

  private async executeOnce(planId:string):Promise<StorageCleanupReceipt> {
    let plan:StorageCleanupPlan;
    try {
      plan = this.review(planId);
    } catch (error) {
      const now = this.dependencies.now().toISOString();
      const receipt:StorageCleanupReceipt = {
        operationId:              this.dependencies.randomId(),
        planId,
        status:                   'expired',
        startedAt:                now,
        finishedAt:               now,
        targets:                  [],
        removedBytes:             0,
        guestFreeSpaceDeltaBytes: 0,
        hostRecovery:             { status: 'not-measured', note: (error as Error).message },
      };
      await this.dependencies.receipts.save(receipt);
      return receipt;
    }
    const receipt:StorageCleanupReceipt = {
      operationId:              this.dependencies.randomId(),
      planId,
      status:                   'executing',
      startedAt:                this.dependencies.now().toISOString(),
      targets:                  plan.targets.map(item => ({ id: item.id, path: item.path, status: 'pending', removedBytes: 0, guestFreeSpaceDeltaBytes: null })),
      removedBytes:             0,
      guestFreeSpaceDeltaBytes: 0,
      hostRecovery:             { status: 'not-measured', note: 'Guest deletion does not prove immediate host sparse-block recovery.' },
    };
    await this.dependencies.receipts.save(receipt);

    for (const planned of plan.targets) {
      const item = receipt.targets.find(target => target.id === planned.id)!;
      try {
        // Freshness boundary: GitHub refs are re-proven immediately before this target's guest removal.
        // A remote ref deleted after this proof and before the helper's bounded run (<= 90 s) is not detectable;
        // no remote lock or retention is claimed.
        const changed = await this.revalidate(planned);
        if (changed) {
          item.status = 'blocked';
          item.reason = sanitizedReason(changed);
        } else {
          const result = await this.dependencies.removeGuest({
            path:           planned.path,
            workspaceRoot:  planned.workspaceRoot,
            source:         planned.source,
            identity:       planned.identity,
            gitFingerprint: planned.gitFingerprint,
          });
          item.status = result.status;
          item.reason = result.reason === undefined ? undefined : sanitizedReason(result.reason);
          item.removedBytes = result.removedBytes;
          item.guestFreeSpaceDeltaBytes = result.guestFreeSpaceDeltaBytes;
        }
      } catch (error) {
        item.status = 'failed';
        item.reason = sanitizedReason(error);
      }
      receipt.removedBytes = receipt.targets.reduce((sum, target) => sum + target.removedBytes, 0);
      receipt.guestFreeSpaceDeltaBytes = receipt.targets.reduce((sum, target) => sum + (target.guestFreeSpaceDeltaBytes ?? 0), 0);
      await this.dependencies.receipts.save(receipt);
    }
    const removed = receipt.targets.filter(item => item.status === 'removed').length;
    const touched = removed + receipt.targets.filter(item => item.status === 'partial').length;
    receipt.status = removed === receipt.targets.length ? 'completed' : touched > 0 ? 'partial' : 'failed';
    receipt.finishedAt = this.dependencies.now().toISOString();
    await this.dependencies.receipts.save(receipt);
    return structuredClone(receipt);
  }
}

let singleton:StorageCleanupService | undefined;
export function getStorageCleanupService():StorageCleanupService {
  singleton ??= new StorageCleanupService();
  return singleton;
}
