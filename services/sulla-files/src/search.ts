// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { basename } from 'node:path';

import { TransactionRunner } from './FilesTransaction.js';
import { cosine, PotionEmbedder, vectorLiteral } from './potionEmbedder.js';
import { FileSearchRepository, type CollectionSearchScope, type SearchCandidate, type SearchFilters } from './Repositories/FileSearchRepository.js';
import { VectorCapability } from './Services/VectorCapability.js';

import type pg from 'pg';

export type { CollectionSearchScope } from './Repositories/FileSearchRepository.js';

export interface SearchInput extends SearchFilters {
  query:         string;
  collectionId?: string;
  terms?:        string[];
  limit?:        number;
}

type Candidate = SearchCandidate;
const SEARCH_TRANSACTION_SLOW_MS = 5_000;
export interface IndexCoverage { total:number; pending:number; indexing:number; indexed:number; partial:number; unsupported:number; failed:number; complete:boolean }
export interface FileSearchResponse { results:any[]; coverage:IndexCoverage }

/** The collaborators FileSearch uses; each defaults to the production implementation on `db`. */
export interface FileSearchDependencies {
  repository?:   FileSearchRepository;
  transactions?: TransactionRunner;
  vectors?:      VectorCapability;
}

export class FileSearch {
  private readonly embedder:     PotionEmbedder;
  private readonly repository:   FileSearchRepository;
  private readonly transactions: TransactionRunner;
  private readonly vectors:      VectorCapability;

  constructor(db:pg.Pool, model:PotionEmbedder | string, dependencies:FileSearchDependencies = {}) {
    this.embedder = typeof model === 'string' ? PotionEmbedder.load(model) : model;
    this.repository = dependencies.repository ?? new FileSearchRepository(db);
    // A bounded search may legitimately hold its read transaction up to the 5 s statement limit.
    this.transactions = dependencies.transactions ?? new TransactionRunner(db, undefined, undefined, SEARCH_TRANSACTION_SLOW_MS);
    this.vectors = dependencies.vectors ?? VectorCapability.forPool(db);
  }

  /**
   * node-pg ignores AbortSignal in QueryConfig. Keep cancellation honest: a running query is
   * bounded by PostgreSQL's transaction-local timeout. A query that hits it yields undefined.
   */
  private async bounded<T>(vector:boolean, read:(repository:FileSearchRepository) => Promise<T>):Promise<T | undefined> {
    try {
      return await this.transactions.run('file-search', async client => {
        const repository = this.repository.on(client);
        await repository.limitStatements(vector);
        return read(repository);
      });
    } catch (error:any) {
      if (error?.code === '57014') {
        console.warn('[SullaFiles] search query reached its 5s database time limit');
        return undefined;
      }
      throw error;
    }
  }

  async search(input:SearchInput, granted:CollectionSearchScope[], signal?:AbortSignal):Promise<FileSearchResponse> {
    const scopes = input.collectionId ? granted.filter(scope => scope.collectionId === input.collectionId) : granted;
    if (!scopes.length) return { results: [], coverage: { total: 0, pending: 0, indexing: 0, indexed: 0, partial: 0, unsupported: 0, failed: 0, complete: true } };
    const coverageRow = await this.repository.coverage(input, scopes);
    const coverage:IndexCoverage = { ...coverageRow, complete: coverageRow.pending === 0 && coverageRow.indexing === 0 && coverageRow.partial === 0 && coverageRow.unsupported === 0 && coverageRow.failed === 0 };
    if (!input.query.trim()) return { results: [], coverage };
    const queryText = input.terms?.length ? input.terms.filter(term => /^[a-z0-9_.-]+$/i.test(term)).join(' OR ') : input.query;
    const keyword = await this.bounded(false, repository => repository.keyword(input, scopes, queryText));

    if (signal?.aborted) return { results: [], coverage };
    const vector = this.embedder.embed(input.query);
    let semantic:Candidate[];
    if (await this.vectors.searchReady()) {
      const literal = vectorLiteral(vector);
      const nearestLimit = input.folder || input.type || input.person || input.from || input.to || input.publishedOnly ? 2000 : 500;
      // Take candidates straight from the HNSW index, then apply visibility/scope filters. If the
      // filters leave fewer than 60 rows, fall back to the exact filtered scan so scoped searches
      // never lose results.
      const nearest = await this.bounded(true, repository => repository.nearestVector(input, scopes, literal, nearestLimit)) ?? [];
      semantic = nearest.length >= 60 ? nearest : await this.bounded(true, repository => repository.exactVector(input, scopes, literal)) ?? nearest;
    } else {
      const bounded = await this.bounded(false, repository => repository.jsonEmbeddingCandidates(input, scopes)) ?? [];
      semantic = bounded.map(row => ({ ...row, signal: cosine(vector, row.embedding_json) })).sort((a, b) => b.signal - a.signal).slice(0, 60);
    }
    semantic = semantic.filter(row => row.signal >= 0.2);

    const fused = new Map<string, any>();
    const add = (candidate:Candidate, source:'keyword' | 'meaning', rank:number) => {
      const current = fused.get(candidate.file_id) ?? { ...candidate, rank: 0, sources: new Set<string>(), bestSignal: -Infinity };
      current.rank += 1 / (60 + rank + 1); current.sources.add(source);
      if (candidate.signal > current.bestSignal) { current.content = candidate.content; current.bestSignal = candidate.signal }
      fused.set(candidate.file_id, current);
    };
    (keyword ?? []).forEach((row, rank) => add(row, 'keyword', rank)); semantic.forEach((row, rank) => add(row, 'meaning', rank));
    const results = [...fused.values()].sort((a, b) => b.rank - a.rank).slice(0, Math.min(input.limit ?? 100, 100)).map(row => ({
      id:            row.file_id,
      title:         basename(row.path),
      path:          row.path,
      mime:          row.mime,
      size:          Number(row.size),
      updated_at:    row.updated_at,
      created_by_id: row.created_by_id,
      rank:          row.rank,
      snippet:       String(row.content ?? '').replace(/\s+/g, ' ').slice(0, 240),
      why:           row.sources.size > 1 ? 'keyword and meaning match' : row.sources.has('meaning') ? 'meaning match' : 'keyword match',
    }));
    return { results, coverage };
  }
}
