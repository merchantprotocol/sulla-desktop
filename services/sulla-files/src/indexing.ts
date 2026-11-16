// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { TransactionRunner } from './FilesTransaction.js';
import { IndexTextExtractor } from './extractor.js';
import { UNINDEXED_SYSTEM_AREAS } from './systemAreaIngest.js';
import { PotionEmbedder, vectorLiteral } from './potionEmbedder.js';
import { IndexingAccountingRepository } from './Repositories/IndexingAccountingRepository.js';
import { IndexingJobRepository, type ClaimedIndexJob, type IndexEligibility } from './Repositories/IndexingJobRepository.js';
import { SearchContentRepository } from './Repositories/SearchContentRepository.js';
import { VectorCapability } from './Services/VectorCapability.js';

import type pg from 'pg';

const CHUNK_CHARS = 3_500;
const CHUNK_OVERLAP = 300;
// Embeddings are intentionally submitted one text at a time. These explicit
// limits keep a future batch embedder from turning a large extracted document
// into a second, unbounded in-memory queue.
export const MAX_EMBEDDING_BATCH_TEXTS = 1;
export const MAX_EMBEDDING_BATCH_CHARS = CHUNK_CHARS;
// Keep a worker's synchronous embedding/SQL burst short, then yield so queued
// uploads and health checks can make progress even with a large persisted backlog.
const INDEX_JOBS_PER_TURN = 10;
// One statement claims a batch (one commit instead of one per job); a few jobs of the batch
// extract and commit side by side, so one job's fsync or file read does not idle the queue.
const INDEX_CLAIM_BATCH = 16;
const INDEX_JOB_CONCURRENCY = 4;

export function* chunks(text:string):Generator<string> {
  for (let start = 0; start < text.length; start += CHUNK_CHARS - CHUNK_OVERLAP) {
    const content = text.slice(start, start + CHUNK_CHARS).trim();
    if (content) yield content;
  }
}

export type IndexSource = (file:any) => Promise<{ path: string; cleanup?: () => Promise<void> }>;

/** The collaborators IndexingQueue uses; each defaults to the production implementation on `db`. */
export interface IndexingQueueDependencies {
  jobs?:         IndexingJobRepository;
  content?:      SearchContentRepository;
  accounting?:   IndexingAccountingRepository;
  transactions?: TransactionRunner;
  vectors?:      VectorCapability;
  extractor?:    IndexTextExtractor;
}

type Eligibility = 'ineligible' | 'stale' | 'current';

function eligibility(file:IndexEligibility | undefined, versionId:string):Eligibility {
  if (!file || file.deleted_at || UNINDEXED_SYSTEM_AREAS.has(file.system_area as string) || file.protected) return 'ineligible';
  return file.current_version_id === versionId ? 'current' : 'stale';
}

export class IndexingQueue {
  private readonly embedder:     PotionEmbedder;
  private readonly jobs:         IndexingJobRepository;
  private readonly content:      SearchContentRepository;
  private readonly accounting:   IndexingAccountingRepository;
  private readonly transactions: TransactionRunner;
  private readonly vectors:      VectorCapability;
  private readonly extractor:    IndexTextExtractor;
  private timer?:            NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private activeJob:string | null = null;
  get diagnosticJob():string | null { return this.activeJob }

  constructor(db:pg.Pool, private readonly source:IndexSource, model:PotionEmbedder | string, dependencies:IndexingQueueDependencies = {}) {
    this.embedder = typeof model === 'string' ? PotionEmbedder.load(model) : model;
    if (this.embedder.dim !== 512) throw new Error(`Expected 512-dimensional Potion model, got ${ this.embedder.dim }`);
    this.jobs = dependencies.jobs ?? new IndexingJobRepository(db);
    this.content = dependencies.content ?? new SearchContentRepository(db);
    this.accounting = dependencies.accounting ?? new IndexingAccountingRepository(db);
    this.transactions = dependencies.transactions ?? new TransactionRunner(db);
    this.vectors = dependencies.vectors ?? VectorCapability.forPool(db);
    this.extractor = dependencies.extractor ?? new IndexTextExtractor();
  }

  async start():Promise<void> {
    this.stopped = false;
    await this.reconcileAccounting();
    this.timer = setInterval(() => this.drain().catch(error => console.error('[SullaFiles] index queue failed', error)), 500);
    this.timer.unref(); this.wake();
  }

  /** Startup repair of jobs and extraction statuses (see IndexingAccountingRepository). */
  async reconcileAccounting():Promise<void> {
    const excluded = [...UNINDEXED_SYSTEM_AREAS];
    await this.transactions.run('index-accounting-reconcile', client => this.accounting.on(client).reconcile(excluded));
  }

  async close():Promise<void> { this.stopped = true; if (this.timer) clearInterval(this.timer); while (this.running) await new Promise(resolve => setTimeout(resolve, 10)); }
  wake():void { setTimeout(() => this.drain().catch(error => console.error('[SullaFiles] index queue failed', error)), 0).unref() }
  async flush():Promise<void> {
    await this.drain();
    while (this.running) await new Promise(resolve => setTimeout(resolve, 10));
  }

  async retry(fileId:string):Promise<void> {
    await this.transactions.run('index-manual-retry', async client => {
      const jobs = this.jobs.on(client);
      const file = await jobs.lockEligibility(fileId);
      if (UNINDEXED_SYSTEM_AREAS.has(file?.system_area as string) || file?.protected) throw new Error('This file is excluded from indexing.');
      if (!file || file.deleted_at || !file.current_version_id) throw new Error('Only a current, active file can be re-indexed.');
      await jobs.requeueManually(fileId, file.current_version_id);
    });
    this.wake();
  }

  private async drain():Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      let processed = 0;
      for (let claimed = await this.processOne(); !this.stopped && claimed; claimed = await this.processOne()) {
        if ((processed += claimed) >= INDEX_JOBS_PER_TURN) {
          processed = 0;
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
    } finally { this.running = false }
  }

  /** Drops the job's derived rows when the file is no longer indexable or the job is superseded. */
  private async discard(jobs:IndexingJobRepository, job:ClaimedIndexJob, state:Exclude<Eligibility, 'current'>):Promise<void> {
    if (state === 'ineligible') await jobs.discardIneligible(job.file_id, job.version_id);
    else await jobs.discardStale(job.file_id, job.version_id);
  }

  /**
   * Claims a batch of due jobs (marking their files `indexing` in the same statement), reads
   * their eligibility without locks and indexes them a few at a time. Returns how many it claimed.
   */
  private async processOne():Promise<number> {
    // The claim and the indexing-state mirror are derived queue state. A lost claim is
    // retried by reconciliation; keeping the batch in one transaction avoids one durable
    // flush per batch without weakening the file/version durability boundary.
    const batch = await this.transactions.run('index-job-claim', client => this.jobs.on(client).claimBatch(INDEX_CLAIM_BATCH));
    if (!batch.length) return 0;
    const snapshots = await this.jobs.readEligibility([...new Set(batch.map(job => String(job.file_id)))]);
    let next = 0;
    const worker = async() => { while (next < batch.length) { const job = batch[next++]; await this.processJob(job, snapshots.get(String(job.file_id))) } };
    await Promise.all(Array.from({ length: Math.min(INDEX_JOB_CONCURRENCY, batch.length) }, worker));
    return batch.length;
  }

  /**
   * Indexes one claimed job. The unlocked snapshot only decides whether to extract: no derived
   * text is written until index-content-commit re-reads eligibility under the file and collection
   * row locks. A job the snapshot calls stale or ineligible is re-checked under those locks (it may
   * have been restored meanwhile) and discarded only if the locked read agrees.
   */
  private async processJob(job:ClaimedIndexJob, snapshot:IndexEligibility | undefined):Promise<void> {
    this.activeJob = String(job.file_id);
    let source:{ path: string; cleanup?: () => Promise<void> } | undefined;
    try {
      const file = eligibility(snapshot, job.version_id) === 'current' ? snapshot : await this.transactions.run('index-eligibility', async client => {
        const jobs = this.jobs.on(client);
        const current = await jobs.lockEligibility(job.file_id);
        const state = eligibility(current, job.version_id);
        if (state !== 'current') { await this.discard(jobs, job, state); return undefined }
        return current;
      });
      if (!file) return;
      source = await this.source(file);
      const extracted = await this.extractor.extract(source.path, file.mime);
      // Capability lookups acquire through the pool; embeddings can be CPU-heavy. Stage
      // both before checkout, then revalidate version/eligibility under the row locks.
      const vectorTable = await this.vectors.tableExists();
      const vectorReady = vectorTable && await this.vectors.searchReady();
      const staged = extracted.status === 'indexed' && extracted.text
        ? [...chunks(extracted.text)].map(content => ({ content, embedding: this.embedder.embed(content) })) : [];
      await this.transactions.run('index-content-commit', async client => {
        const jobs = this.jobs.on(client); const content = this.content.on(client);
        const state = eligibility(await jobs.lockEligibility(file.id), job.version_id);
        if (state !== 'current') { await this.discard(jobs, job, state); return true }
        const activeJob = await jobs.lockJob(job.version_id);
        if (activeJob?.status !== 'indexing' || Number(activeJob.attempts) !== Number(job.attempts)) {
          return true;
        }
        await content.deleteChunksForFile(file.id);
        if (extracted.status === 'indexed' && extracted.text) {
          let ordinal = 0;
          for (const { content: text, embedding } of staged) {
            const chunkId = await content.insertChunk(file.id, job.version_id, ordinal, text, vectorReady ? null : JSON.stringify(Array.from(embedding)));
            if (vectorTable) await content.insertVector(chunkId, vectorLiteral(embedding));
            ordinal++;
          }
        }
        await content.upsertText(file.id, file.path, extracted.text);
        await jobs.complete(file.id, job.version_id, extracted);
      });
    } catch {
      await this.recordFailure(job);
    } finally {
      this.activeJob = null;
      try { await source?.cleanup?.() } catch { console.warn('[SullaFiles] index source cleanup failed') }
    }
  }

  /** Re-queues a failed job (or fails it after three attempts) while this worker still owns it. */
  private async recordFailure(job:ClaimedIndexJob):Promise<void> {
    const terminal = job.attempts >= 3;
    const outcome = {
      status:     terminal ? 'failed' : 'pending',
      reasonCode: terminal ? 'retry_exhausted' : 'retry_scheduled',
      reason:     terminal ? 'Indexing failed after three local attempts. Re-index to try again.' : 'Indexing hit a temporary local error and will retry.',
    };
    await this.transactions.run('index-failure', async client => {
      const jobs = this.jobs.on(client);
      const state = eligibility(await jobs.lockEligibility(job.file_id), job.version_id);
      if (state !== 'current') { await this.discard(jobs, job, state); return }
      if (await jobs.rescheduleOwnedJob(job, outcome, 'Local indexing operation failed')) await jobs.markFileRetry(job.file_id, job.version_id, outcome);
    });
  }
}
