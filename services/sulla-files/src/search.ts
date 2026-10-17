import { basename } from 'node:path';

import { cosine, PotionEmbedder, vectorLiteral } from './potionEmbedder.js';

import type { CollectionSearchScope } from './acl.js';
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

function filteredWhere(input:SearchInput, scopes:CollectionSearchScope[], args:any[]):string[] {
  const grants = scopes.map(scope => {
    const collection = args.push(scope.collectionId); const paths = args.push(scope.paths);
    return `(f.collection_id=$${ collection } AND (cardinality($${ paths }::text[])=0 OR EXISTS(SELECT 1 FROM unnest($${ paths }::text[]) p WHERE f.path=p OR starts_with(f.path,p||'/'))))`;
  });
  const where = [`(${ grants.join(' OR ') })`, 'f.deleted_at IS NULL', "lower(f.path) !~ '(^|/)master[.]key($|/)'", 'NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)'];
  if (input.folder) where.push(`f.path LIKE $${ args.push(`${ input.folder.replace(/[\\%_]/g, value => `\\${ value }`) }%`) } ESCAPE '\\'`);
  if (input.type) where.push(`f.mime=$${ args.push(input.type) }`);
  if (input.person) where.push(`(f.person_id=$${ args.push(input.person) } OR f.created_by_id=$${ args.length })`);
  if (input.from) where.push(`f.updated_at >= $${ args.push(input.from) }`);
  if (input.to) where.push(`f.updated_at <= $${ args.push(input.to) }`);
  return where;
}

export class FileSearch {
  private readonly embedder: PotionEmbedder;
  private vectorTable?:      boolean;
  constructor(private readonly db:pg.Pool, model:PotionEmbedder | string) { this.embedder = typeof model === 'string' ? PotionEmbedder.load(model) : model }

  private async hasVectorTable():Promise<boolean> {
    if (this.vectorTable !== undefined) return this.vectorTable;
    this.vectorTable = Boolean((await this.db.query("SELECT to_regclass('file_search_vectors') name")).rows[0]?.name);
    return this.vectorTable;
  }

  async search(input:SearchInput, granted:CollectionSearchScope[]):Promise<any[]> {
    const scopes = input.collectionId ? granted.filter(scope => scope.collectionId === input.collectionId) : granted;
    if (!scopes.length || !input.query.trim()) return [];
    const queryText = input.terms?.length ? input.terms.filter(term => /^[a-z0-9_.-]+$/i.test(term)).join(' OR ') : input.query;
    const keywordArgs:any[] = []; const keywordWhere = filteredWhere(input, scopes, keywordArgs);
    keywordArgs.push(queryText);
    const keyword = await this.db.query<Candidate>(`SELECT f.id file_id,f.path,f.mime,f.size,f.updated_at,f.created_by_id,sc.content,
      GREATEST(ts_rank_cd(sc.search_vector,websearch_to_tsquery('simple',$${ keywordArgs.length })),ts_rank_cd(f.search_vector,websearch_to_tsquery('simple',$${ keywordArgs.length }))) signal
      FROM files f LEFT JOIN file_search_chunks sc ON sc.file_id=f.id AND sc.version_id=f.current_version_id
      WHERE ${ keywordWhere.join(' AND ') } AND (sc.search_vector @@ websearch_to_tsquery('simple',$${ keywordArgs.length }) OR f.search_vector @@ websearch_to_tsquery('simple',$${ keywordArgs.length }))
      ORDER BY signal DESC,f.updated_at DESC LIMIT 60`, keywordArgs);

    const vector = this.embedder.embed(input.query);
    let semantic:Candidate[];
    const semanticArgs:any[] = []; const semanticWhere = filteredWhere(input, scopes, semanticArgs);
    if (await this.hasVectorTable()) {
      semanticArgs.push(vectorLiteral(vector));
      semantic = (await this.db.query<Candidate>(`SELECT f.id file_id,f.path,f.mime,f.size,f.updated_at,f.created_by_id,sc.content,
        1-(sv.embedding <=> $${ semanticArgs.length }::vector) signal
        FROM files f JOIN file_search_chunks sc ON sc.file_id=f.id JOIN file_search_vectors sv ON sv.chunk_id=sc.id
        WHERE ${ semanticWhere.join(' AND ') } AND sc.version_id=f.current_version_id
        ORDER BY sv.embedding <=> $${ semanticArgs.length }::vector LIMIT 60`, semanticArgs)).rows;
    } else {
      const bounded = (await this.db.query<any>(`SELECT f.id file_id,f.path,f.mime,f.size,f.updated_at,f.created_by_id,sc.content,sc.embedding_json
        FROM files f JOIN file_search_chunks sc ON sc.file_id=f.id WHERE ${ semanticWhere.join(' AND ') } AND sc.version_id=f.current_version_id
        ORDER BY f.updated_at DESC LIMIT 800`, semanticArgs)).rows;
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
    keyword.rows.forEach((row, rank) => add(row, 'keyword', rank)); semantic.forEach((row, rank) => add(row, 'meaning', rank));
    return [...fused.values()].sort((a, b) => b.rank - a.rank).slice(0, Math.min(input.limit ?? 100, 100)).map(row => ({
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
  }
}
