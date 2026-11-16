// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { UNINDEXED_SYSTEM_AREAS } from '../systemAreaIngest.js';

import type { SearchQueryable } from './IndexingJobRepository.js';

export interface CollectionSearchScope { collectionId:string }

/** The filters a search applies to the files it may return. */
export interface SearchFilters {
  folder?:        string;
  type?:          string;
  person?:        string;
  from?:          string;
  to?:            string;
  publishedOnly?: boolean;
}

export interface SearchCandidate { file_id: string; path: string; mime: string; size: string; updated_at: string; created_by_id: string; content: string | null; signal: number }
export interface JsonEmbeddingCandidate extends Omit<SearchCandidate, 'signal'> { embedding_json:unknown }
export interface CoverageCounts { total:number; pending:number; indexing:number; indexed:number; partial:number; unsupported:number; failed:number }

/**
 * Search reads over the caller's granted collections. Every query applies the same
 * visibility predicate: granted collection, not deleted, not protected, not in an
 * unindexed system area, never a vault/wallet/master key path, current version only.
 *
 * Candidate queries (keyword, nearest, exact, JSON) run on the client of a short
 * transaction that `limitStatements` bounded with a 5 s statement timeout.
 */
export class FileSearchRepository {
  constructor(private readonly db:SearchQueryable) {}

  on(client:SearchQueryable):FileSearchRepository { return new FileSearchRepository(client) }

  private filteredWhere(input:SearchFilters, scopes:CollectionSearchScope[], args:any[]):string[] {
    const collectionIds=args.push(scopes.map(scope=>scope.collectionId));
    const unindexed = args.push([...UNINDEXED_SYSTEM_AREAS]);
    const where = [`NOT EXISTS(SELECT 1 FROM collections c WHERE c.id=f.collection_id AND c.system_area=ANY($${ unindexed }::text[]))`, `f.collection_id=ANY($${collectionIds}::uuid[])`, 'f.deleted_at IS NULL', "lower(replace(f.path,chr(92),'/')) !~ '(^|/)(master[.]key|[^/]*wallet[^/]*|vault|vaults)($|/)'", 'NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)'];
    if (input.folder) where.push(`f.path LIKE $${ args.push(`${ input.folder.replace(/[\\%_]/g, value => `\\${ value }`) }%`) } ESCAPE '\\'`);
    if (input.type) where.push(`f.mime=$${ args.push(input.type) }`);
    if (input.person) where.push(`(f.person_id=$${ args.push(input.person) } OR f.created_by_id=$${ args.length })`);
    if (input.from) where.push(`f.updated_at >= $${ args.push(input.from) }`);
    if (input.to) where.push(`f.updated_at <= $${ args.push(input.to) }`);
    // Recall must never surface unpublished drafts (e.g. a draft SKILL.md under Use Cases).
    if (input.publishedOnly) where.push('f.published_version_id IS NOT NULL AND f.current_version_id = f.published_version_id');
    return where;
  }

  /** Bounds the transaction's statements; vector reads also widen the HNSW search. */
  async limitStatements(vector:boolean):Promise<void> {
    await this.db.query("SET LOCAL statement_timeout = '5s'");
    if (vector) {
      await this.db.query("SET LOCAL hnsw.ef_search = 200");
      await this.db.query("SET LOCAL hnsw.iterative_scan = strict_order");
    }
  }

  /** Index status of the current versions of every visible file the filters match. */
  async coverage(input:SearchFilters, scopes:CollectionSearchScope[]):Promise<CoverageCounts> {
    const coverageArgs:any[] = []; const coverageWhere = this.filteredWhere(input, scopes, coverageArgs); const coverageVersion = 'f.current_version_id';
    return (await this.db.query<any>(`SELECT COUNT(*)::int total,
      COUNT(*) FILTER(WHERE ij.status='pending')::int pending,
      COUNT(*) FILTER(WHERE ij.status='indexing')::int indexing,
      COUNT(*) FILTER(WHERE ij.status='indexed')::int indexed,
      COUNT(*) FILTER(WHERE ij.status='indexed' AND right(ij.reason_code,8)='_partial')::int partial,
      COUNT(*) FILTER(WHERE ij.status='unsupported')::int unsupported,
      COUNT(*) FILTER(WHERE ij.status='failed')::int failed
      FROM files f LEFT JOIN file_index_jobs ij ON ij.version_id=${ coverageVersion } WHERE ${ coverageWhere.join(' AND ') } AND ${ coverageVersion } IS NOT NULL`, coverageArgs)).rows[0];
  }

  /**
   * Full-text matches. Visibility is materialized before matching, then the chunk index is
   * restricted to current version IDs: neither global log matches nor drafts can consume
   * the candidate cap; the existing version/ordinal index bounds the scan.
   */
  async keyword(input:SearchFilters, scopes:CollectionSearchScope[], queryText:string):Promise<SearchCandidate[]> {
    const keywordArgs:any[] = []; const keywordWhere = this.filteredWhere(input, scopes, keywordArgs); const keywordVersion = 'f.current_version_id';
    keywordArgs.push(queryText);
    return (await this.db.query<SearchCandidate>(`WITH eligible AS MATERIALIZED (
        SELECT f.id,f.current_version_id,f.path,f.mime,v.size,f.updated_at,f.created_by_id
        FROM files f JOIN file_versions v ON v.id=${ keywordVersion }
        WHERE ${ keywordWhere.join(' AND ') }
      ), matches AS MATERIALIZED (
        SELECT sc.file_id,sc.version_id,sc.content,sc.search_vector
        FROM file_search_chunks sc
        WHERE sc.version_id=ANY(ARRAY(SELECT current_version_id FROM eligible))
          AND sc.search_vector @@ websearch_to_tsquery('simple',$${ keywordArgs.length })
          AND EXISTS(SELECT 1 FROM eligible f WHERE f.id=sc.file_id AND f.current_version_id=sc.version_id)
        LIMIT 200
      )
      SELECT f.id file_id,f.path,f.mime,f.size,f.updated_at,f.created_by_id,sc.content,
        ts_rank_cd(sc.search_vector,websearch_to_tsquery('simple',$${ keywordArgs.length })) signal
      FROM matches sc JOIN eligible f ON f.id=sc.file_id AND f.current_version_id=sc.version_id
      ORDER BY signal DESC,f.updated_at DESC LIMIT 60`, keywordArgs)).rows;
  }

  /**
   * Nearest chunks straight from the HNSW index (no joins, so the planner can use it),
   * then the visibility/scope filters. Can return fewer than 60 rows when filters drop
   * candidates; `exactVector` is the fallback.
   */
  async nearestVector(input:SearchFilters, scopes:CollectionSearchScope[], literal:string, nearestLimit:number):Promise<SearchCandidate[]> {
    const semanticArgs:any[] = []; const semanticWhere = this.filteredWhere(input, scopes, semanticArgs); const semanticVersion = 'f.current_version_id';
    semanticArgs.push(literal);
    const q = `$${ semanticArgs.length }::halfvec`;
    return (await this.db.query<SearchCandidate>(`WITH nearest AS MATERIALIZED (
          SELECT chunk_id, embedding <=> ${ q } dist FROM file_search_vectors ORDER BY embedding <=> ${ q } LIMIT ${ Math.trunc(nearestLimit) })
        SELECT f.id file_id,f.path,f.mime,v.size,f.updated_at,f.created_by_id,sc.content,1-n.dist signal
        FROM nearest n JOIN file_search_chunks sc ON sc.id=n.chunk_id JOIN files f ON f.id=sc.file_id JOIN file_versions v ON v.id=${ semanticVersion }
        WHERE ${ semanticWhere.join(' AND ') } AND sc.version_id=${ semanticVersion }
        ORDER BY n.dist LIMIT 60`, semanticArgs)).rows;
  }

  /** Exact filtered nearest-neighbour scan, so scoped searches never lose results. */
  async exactVector(input:SearchFilters, scopes:CollectionSearchScope[], literal:string):Promise<SearchCandidate[]> {
    const semanticArgs:any[] = []; const semanticWhere = this.filteredWhere(input, scopes, semanticArgs); const semanticVersion = 'f.current_version_id';
    semanticArgs.push(literal);
    const q = `$${ semanticArgs.length }::halfvec`;
    return (await this.db.query<SearchCandidate>(`SELECT f.id file_id,f.path,f.mime,v.size,f.updated_at,f.created_by_id,sc.content,
        1-(sv.embedding <=> ${ q }) signal
        FROM files f JOIN file_versions v ON v.id=${ semanticVersion } JOIN file_search_chunks sc ON sc.file_id=f.id JOIN file_search_vectors sv ON sv.chunk_id=sc.id
        WHERE ${ semanticWhere.join(' AND ') } AND sc.version_id=${ semanticVersion }
        ORDER BY sv.embedding <=> ${ q } LIMIT 60`, semanticArgs)).rows;
  }

  /** Without pgvector: the 800 most recently updated visible chunks with their JSON embeddings. */
  async jsonEmbeddingCandidates(input:SearchFilters, scopes:CollectionSearchScope[]):Promise<JsonEmbeddingCandidate[]> {
    const semanticArgs:any[] = []; const semanticWhere = this.filteredWhere(input, scopes, semanticArgs); const semanticVersion = 'f.current_version_id';
    return (await this.db.query<JsonEmbeddingCandidate>(`SELECT f.id file_id,f.path,f.mime,v.size,f.updated_at,f.created_by_id,sc.content,sc.embedding_json
        FROM files f JOIN file_versions v ON v.id=${ semanticVersion } JOIN file_search_chunks sc ON sc.file_id=f.id WHERE ${ semanticWhere.join(' AND ') } AND sc.version_id=v.id
        ORDER BY f.updated_at DESC LIMIT 800`, semanticArgs)).rows;
  }
}
