import { basename } from 'node:path';

import { PotionEmbedder, vectorLiteral } from './potionEmbedder.js';
import type { VectorSearchStatus } from './vectorUpgrade.js';

export interface CollectionSearchScope { collectionId:string }
import type pg from 'pg';

export interface SearchInput {
  query:         string;
  collectionId?: string;
  folder?:       string;
  type?:         string;
  person?:       string;
  from?:         string;
  to?:           string;
  terms?:        string[];
  limit?:        number;
}

interface Candidate { file_id: string; path: string; mime: string; size: string; updated_at: string; created_by_id: string; content: string | null; signal: number }
export interface IndexCoverage { total:number; pending:number; indexing:number; indexed:number; partial:number; unsupported:number; failed:number; complete:boolean }
export interface FileSearchResponse { results:any[]; coverage:IndexCoverage }

function filteredWhere(input:SearchInput, scopes:CollectionSearchScope[], args:any[]):string[] {
  const collectionIds=args.push(scopes.map(scope=>scope.collectionId));
  const where = [`f.collection_id=ANY($${collectionIds}::uuid[])`, 'f.deleted_at IS NULL', "lower(f.path) !~ '(^|/)(master[.]key|wallet|vault|vaults)($|/)'", 'NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)'];
  if (input.folder) where.push(`f.path LIKE $${ args.push(`${ input.folder.replace(/[\\%_]/g, value => `\\${ value }`) }%`) } ESCAPE '\\'`);
  if (input.type) where.push(`f.mime=$${ args.push(input.type) }`);
  if (input.person) where.push(`(f.person_id=$${ args.push(input.person) } OR f.created_by_id=$${ args.length })`);
  if (input.from) where.push(`f.updated_at >= $${ args.push(input.from) }`);
  if (input.to) where.push(`f.updated_at <= $${ args.push(input.to) }`);
  return where;
}

/**
 * Nearest chunks pulled from HNSW before the authorization/path filters run.
 * Also the HNSW ef_search, so one index probe yields the whole pool.
 */
export const SEMANTIC_POOL = 400;
const SEMANTIC_LIMIT = 60;

export interface VectorSearchSource { readonly columnReady:boolean; status():VectorSearchStatus }

export class FileSearch {
  private readonly embedder: PotionEmbedder;
  /**
   * Semantic retrieval runs in SQL on file_search_chunks.embedding once that
   * column exists (VectorSearchUpgrade). Without pgvector, search is full-text only.
   */
  constructor(private readonly db:pg.Pool, model:PotionEmbedder | string, private readonly vectors?:VectorSearchSource) { this.embedder = typeof model === 'string' ? PotionEmbedder.load(model) : model }

  vectorStatus():VectorSearchStatus { return this.vectors?.status() ?? { vectorSearch: 'unavailable', phase: 'not-configured' } }

  private async semanticCandidates(input:SearchInput, scopes:CollectionSearchScope[], vector:Float32Array):Promise<Candidate[]> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL hnsw.ef_search = ${ SEMANTIC_POOL }`);
      // strict_order: if the scan must continue (fallback below), keep exact distance order.
      await client.query("SET LOCAL hnsw.iterative_scan = 'strict_order'");
      const select = 'f.id file_id,f.path,f.mime,v.size,f.updated_at,f.created_by_id';
      // 1) Nearest chunks from the HNSW index alone (a single-table ORDER BY ... LIMIT,
      //    the shape the planner reliably serves from the index), then the same
      //    filters as keyword search. Exact whenever >= 60 rows survive the filters.
      const pooledArgs:any[] = []; const pooledWhere = filteredWhere(input, scopes, pooledArgs);
      const q = pooledArgs.push(vectorLiteral(vector));
      let rows = (await client.query<Candidate>(`WITH nearest AS MATERIALIZED (
          SELECT sc.file_id,sc.version_id,sc.content,sc.embedding <=> $${ q }::vector distance
          FROM file_search_chunks sc WHERE sc.embedding IS NOT NULL ORDER BY sc.embedding <=> $${ q }::vector LIMIT ${ SEMANTIC_POOL })
        SELECT ${ select },n.content,1-n.distance signal
        FROM nearest n JOIN files f ON f.id=n.file_id JOIN file_versions v ON v.id=f.current_version_id AND v.id=n.version_id
        WHERE ${ pooledWhere.join(' AND ') } ORDER BY n.distance LIMIT ${ SEMANTIC_LIMIT }`, pooledArgs)).rows;
      // 2) Filters rejected too much of the pool (narrow folder/collection/type):
      //    filter inside the scan instead. Small tables land here too; both are cheap.
      if (rows.length < SEMANTIC_LIMIT) {
        const args:any[] = []; const where = filteredWhere(input, scopes, args); const p = args.push(vectorLiteral(vector));
        rows = (await client.query<Candidate>(`SELECT ${ select },sc.content,1-(sc.embedding <=> $${ p }::vector) signal
          FROM files f JOIN file_versions v ON v.id=f.current_version_id JOIN file_search_chunks sc ON sc.file_id=f.id AND sc.version_id=v.id
          WHERE ${ where.join(' AND ') } AND sc.embedding IS NOT NULL
          ORDER BY sc.embedding <=> $${ p }::vector LIMIT ${ SEMANTIC_LIMIT }`, args)).rows;
      }
      await client.query('COMMIT');
      return rows.map(row => ({ ...row, signal: Number(row.signal) }));
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error } finally { client.release() }
  }

  async search(input:SearchInput, granted:CollectionSearchScope[]):Promise<FileSearchResponse> {
    const scopes = input.collectionId ? granted.filter(scope => scope.collectionId === input.collectionId) : granted;
    if (!scopes.length) return { results: [], coverage: { total: 0, pending: 0, indexing: 0, indexed: 0, partial: 0, unsupported: 0, failed: 0, complete: true } };
    const visibleVersion = (_args:any[]) => 'f.current_version_id';
    const coverageArgs:any[] = []; const coverageWhere = filteredWhere(input, scopes, coverageArgs); const coverageVersion = visibleVersion(coverageArgs);
    const coverageRow = (await this.db.query<any>(`SELECT COUNT(*)::int total,
      COUNT(*) FILTER(WHERE ij.status='pending')::int pending,
      COUNT(*) FILTER(WHERE ij.status='indexing')::int indexing,
      COUNT(*) FILTER(WHERE ij.status='indexed')::int indexed,
      COUNT(*) FILTER(WHERE ij.status='indexed' AND right(ij.reason_code,8)='_partial')::int partial,
      COUNT(*) FILTER(WHERE ij.status='unsupported')::int unsupported,
      COUNT(*) FILTER(WHERE ij.status='failed')::int failed
      FROM files f LEFT JOIN file_index_jobs ij ON ij.version_id=${ coverageVersion } WHERE ${ coverageWhere.join(' AND ') } AND ${ coverageVersion } IS NOT NULL`, coverageArgs)).rows[0];
    const coverage:IndexCoverage = { ...coverageRow, complete: coverageRow.pending === 0 && coverageRow.indexing === 0 && coverageRow.partial === 0 && coverageRow.unsupported === 0 && coverageRow.failed === 0 };
    if (!input.query.trim()) return { results: [], coverage };
    const queryText = input.terms?.length ? input.terms.filter(term => /^[a-z0-9_.-]+$/i.test(term)).join(' OR ') : input.query;
    const keywordArgs:any[] = []; const keywordWhere = filteredWhere(input, scopes, keywordArgs); const keywordVersion = visibleVersion(keywordArgs);
    keywordArgs.push(queryText);
    const keyword = await this.db.query<Candidate>(`SELECT f.id file_id,f.path,f.mime,v.size,f.updated_at,f.created_by_id,sc.content,
      ts_rank_cd(sc.search_vector,websearch_to_tsquery('simple',$${ keywordArgs.length })) signal
      FROM files f JOIN file_versions v ON v.id=${ keywordVersion } LEFT JOIN file_search_chunks sc ON sc.file_id=f.id AND sc.version_id=v.id
      WHERE ${ keywordWhere.join(' AND ') } AND sc.search_vector @@ websearch_to_tsquery('simple',$${ keywordArgs.length })
      ORDER BY signal DESC,f.updated_at DESC LIMIT 60`, keywordArgs);

    let semantic:Candidate[] = [];
    if (this.vectors?.columnReady) semantic = await this.semanticCandidates(input, scopes, this.embedder.embed(input.query));
    semantic = semantic.filter(row => row.signal >= 0.2);

    const fused = new Map<string, any>();
    const add = (candidate:Candidate, source:'keyword' | 'meaning', rank:number) => {
      const current = fused.get(candidate.file_id) ?? { ...candidate, rank: 0, sources: new Set<string>(), bestSignal: -Infinity };
      current.rank += 1 / (60 + rank + 1); current.sources.add(source);
      if (candidate.signal > current.bestSignal) { current.content = candidate.content; current.bestSignal = candidate.signal }
      fused.set(candidate.file_id, current);
    };
    keyword.rows.forEach((row, rank) => add(row, 'keyword', rank)); semantic.forEach((row, rank) => add(row, 'meaning', rank));
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
