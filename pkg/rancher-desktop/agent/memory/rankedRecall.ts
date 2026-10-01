/**
 * Ranked memory recall — one ranking across every memory domain.
 *
 * Pipeline (validated in ~/sulla/projects/memory-recall-lab, 2026-09-30, on
 * 100 real queries / 699 relevance judgments):
 *   1. Candidates: BM25 top 40 + potion dense top 40, fused with RRF (k=60).
 *   2. Features: 13 retrieval/overlap/age/shape signals + domain one-hot.
 *   3. Score: logistic regression (weights in ranker_v1.json).
 *   4. Collapse near-duplicates (cosine ≥ 0.92) and return the top 16.
 * searchPerDomain() runs the same pipeline inside each domain and keeps the
 * top 16 of every domain, so busy domains can't crowd out quiet ones.
 * Lab result at top 16: ~83–86% of "needed" memories surfaced, vs 41% for the
 * per-domain SQL keyword recall it replaces. Single-judge labels — treat the
 * number as directional; shadow comparisons in perf.log are the real check.
 *
 * This module is pure (no DB, no I/O) so the exact lab pipeline can be tested.
 * Feature order and formulas MUST match the lab's ranker.py/features().
 */

import { PotionEmbedder, truncateCodePoints } from './potionEmbedder';
import RANKER_V1 from './ranker_v1.json';

export interface RankerModel {
  version:        string;
  candidateK:     number;
  rrfK:           number;
  returnK:        number;
  dedupCosine:    number;
  contextWeights: number[];
  docChars:       number;
  queryChars:     number;
  domains:        string[];
  features:       string[];
  mean:           number[];
  scale:          number[];
  coef:           number[];
  intercept:      number;
}

export const DEFAULT_RANKER: RankerModel = RANKER_V1 as RankerModel;

export interface MemoryRow {
  id:      string;
  /** identity domain (human, agent, …) or 'observation' for the observations table. */
  domain:  string;
  /** identity level 1–3; null for observations. */
  level:   number | null;
  /** YYYY-MM-DD the memory was recorded. */
  date:    string;
  content: string;
}

export interface RankedHit {
  row:   MemoryRow;
  score: number;
}

// ── Lexical tokenizer (port of lab.py tokenize / STOP / stem) ───────────────
const STOP_856 = new Set(`
the and for with that this from have what your you are was were will would could should about into they them their there then
than just like also some more most very much make made does done did can not but all any our out its get got want wants wanted
need needs please thanks thank okay yes now new use using used here when where which while who whom why how been being able
still only even over under after before again each every other same such own too via per may might must shall let lets ill
dont cant isnt really sure know think going continue pursuing goal goals review system good success looking ways trying within
improve ready work working works thing things stuff help start started starting look looked keep take took give gave put find
found show tell told said says call called time times today yesterday tomorrow week day days lot lots little big small great
better best right wrong fine gone come came into onto upon well back down doing having maybe yeah yea hey okay alright
`.split(/\s+/).filter(Boolean));
const STOP = new Set([...STOP_856, ...'i me my we us a an is it to of in on at or be as by if so do no up go im ive youre its thats theres whats'.split(' ')]);
const TAGGED_RE = /<([a-z_][a-z0-9_-]*)>[\s\S]*?<\/\1>/gi;
const SUFFIXES = ['ingly', 'edly', 'ing', 'ers', 'ies', 'ied', 'es', 'ed', 'er', 'ly', 's'];

function stem(w: string): string {
  for (const suf of SUFFIXES) {
    if (w.length > suf.length + 3 && w.endsWith(suf)) {
      return w.slice(0, -suf.length) + (suf === 'ies' || suf === 'ied' ? 'y' : '');
    }
  }

  return w;
}

export function recallTokenize(text: string): string[] {
  const clean = (text || '').toLowerCase().replace(TAGGED_RE, ' ').replace(/https?:\/\/\S+/g, ' ');
  const toks: string[] = [];

  for (const raw of clean.match(/[a-z0-9][a-z0-9_]*/g) ?? []) {
    if (STOP.has(raw) || raw.length < 2) continue;
    toks.push(/^[a-z]+$/.test(raw) ? stem(raw) : raw);
  }

  return toks;
}

// ── Index ────────────────────────────────────────────────────────────────────
const BM25_K1 = 1.2;
const BM25_B = 0.75;

export class RankedRecallIndex {
  readonly rows:            MemoryRow[];
  readonly dim:             number;
  private readonly emb:     Float32Array;
  private readonly docLen:  number[];
  private readonly tf:      Map<string, number>[];
  private readonly tokSets: Set<string>[];
  private readonly idf = new Map<string, number>();
  private readonly post = new Map<string, number[]>();
  private readonly avgLen:  number;

  constructor(rows: MemoryRow[], private readonly embedder: PotionEmbedder, private readonly model: RankerModel = DEFAULT_RANKER) {
    this.rows = rows;
    this.dim = embedder.dim;
    this.emb = new Float32Array(rows.length * this.dim);
    this.docLen = [];
    this.tf = [];
    this.tokSets = [];
    const df = new Map<string, number>();

    rows.forEach((r, i) => {
      const toks = recallTokenize(r.content);
      const tf = new Map<string, number>();

      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      this.docLen.push(toks.length);
      this.tf.push(tf);
      this.tokSets.push(new Set(toks));
      for (const t of tf.keys()) {
        df.set(t, (df.get(t) ?? 0) + 1);
        let list = this.post.get(t);

        if (!list) { list = []; this.post.set(t, list) }
        list.push(i);
      }
      this.emb.set(embedder.embed(truncateCodePoints(r.content, model.docChars)), i * this.dim);
    });
    const n = rows.length;

    this.avgLen = n ? this.docLen.reduce((a, b) => a + b, 0) / n : 1;
    for (const [t, c] of df) this.idf.set(t, Math.log(1 + (n - c + 0.5) / (c + 0.5)));
  }

  private dot(i: number, q: Float32Array): number {
    let s = 0;
    const off = i * this.dim;

    for (let d = 0; d < this.dim; d++) s += this.emb[off + d] * q[d];

    return s;
  }

  private rowDot(i: number, j: number): number {
    let s = 0;
    const a = i * this.dim; const b = j * this.dim;

    for (let d = 0; d < this.dim; d++) s += this.emb[a + d] * this.emb[b + d];

    return s;
  }

  private bm25(context: string[], domain?: string): [number, number][] {
    const sc = new Map<number, number>();

    context.forEach((text, ci) => {
      const qw = this.model.contextWeights[ci] ?? 0;

      if (!qw) return;
      for (const t of new Set(recallTokenize(text))) {
        const idf = this.idf.get(t);

        if (idf === undefined) continue;
        for (const i of this.post.get(t) ?? []) {
          if (domain !== undefined && this.rows[i].domain !== domain) continue;
          const f = this.tf[i].get(t) ?? 0;
          const norm = f + BM25_K1 * (1 - BM25_B + BM25_B * this.docLen[i] / this.avgLen);

          sc.set(i, (sc.get(i) ?? 0) + qw * idf * f * (BM25_K1 + 1) / norm);
        }
      }
    });

    return [...sc.entries()].sort((a, b) => b[1] - a[1]).slice(0, this.model.candidateK);
  }

  private queryVector(context: string[]): Float32Array {
    const v = new Float32Array(this.dim);

    context.forEach((text, ci) => {
      const w = this.model.contextWeights[ci] ?? 0;

      if (!w) return;
      const e = this.embedder.embed(truncateCodePoints(text, this.model.queryChars));

      for (let d = 0; d < this.dim; d++) v[d] += w * e[d];
    });
    let norm = 0;

    for (let d = 0; d < this.dim; d++) norm += v[d] * v[d];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let d = 0; d < this.dim; d++) v[d] /= norm;

    return v;
  }

  /**
   * Rank every memory for this turn.
   * @param context  latest user message first, then up to 2 earlier ones.
   * @param today    YYYY-MM-DD used for the memory-age feature.
   * @param domain   restrict candidates to one domain (used by searchPerDomain).
   */
  search(context: string[], today: string, returnK = this.model.returnK, domain?: string): RankedHit[] {
    const m = this.model;
    const ctx = context.filter(t => t?.trim()).slice(0, m.contextWeights.length);

    if (ctx.length === 0 || this.rows.length === 0) return [];

    // 1. candidates
    const b = this.bm25(ctx, domain);
    const qv = this.queryVector(ctx);
    const dAll: [number, number][] = [];

    this.rows.forEach((r, i) => { if (domain === undefined || r.domain === domain) dAll.push([i, this.dot(i, qv)]) });
    const d = dAll.sort((x, y) => y[1] - x[1]).slice(0, m.candidateK);
    const rrf = new Map<number, number>();

    for (const list of [b, d]) list.forEach(([i], rank) => rrf.set(i, (rrf.get(i) ?? 0) + 1 / (m.rrfK + rank + 1)));
    const fused = [...rrf.entries()].sort((x, y) => y[1] - x[1]).slice(0, m.candidateK);

    // 2. features
    const bs = new Map(b); const ds = new Map(d);
    const br = new Map(b.map(([i], r) => [i, r])); const dr = new Map(d.map(([i], r) => [i, r]));
    const bmax = b.length ? Math.max(...b.map(x => x[1])) : 1;
    const dmax = d.length ? Math.max(...d.map(x => x[1])) : 1;
    const qtok = new Set(recallTokenize(ctx.join(' ')));
    const qnow = new Set(recallTokenize(ctx[0]));
    const qnum = [...qtok].filter(t => /\d/.test(t));
    const todayMs = Date.parse(`${ today }T00:00:00Z`);

    const scored: RankedHit[] = fused.map(([i, f], rank) => {
      const row = this.rows[i];
      const toks = this.tokSets[i];
      const dsim = ds.get(i) ?? this.dot(i, qv);
      const rowMs = row.date ? Date.parse(`${ row.date.slice(0, 10) }T00:00:00Z`) : NaN;
      const age = Number.isFinite(rowMs) && Number.isFinite(todayMs) ? Math.round((todayMs - rowMs) / 86_400_000) : 30;
      let ovNow = 0; let ov = 0; let numOv = 0;

      for (const t of qnow) if (toks.has(t)) ovNow++;
      for (const t of qtok) if (toks.has(t)) ov++;
      for (const t of qnum) if (toks.has(t)) numOv++;
      const x = [
        f * 60,
        Math.log1p(rank),
        bmax ? (bs.get(i) ?? 0) / bmax : 0,
        1 / (1 + (br.get(i) ?? 60)),
        dsim,
        dsim - dmax,
        1 / (1 + (dr.get(i) ?? 60)),
        ovNow / (1 + qnow.size),
        ov / (1 + qtok.size),
        numOv,
        Math.log1p(Math.max(age, 0)),
        row.level === 3 ? 1 : 0,
        Math.log1p(Array.from(row.content).length),
        ...m.domains.map(dom => (row.domain === dom ? 1 : 0)),
      ];
      let z = m.intercept;

      for (let k = 0; k < x.length; k++) z += ((x[k] - m.mean[k]) / m.scale[k]) * m.coef[k];

      return { row, score: 1 / (1 + Math.exp(-z)), _i: i } as RankedHit & { _i: number };
    });

    // 3. score order, 4. near-duplicate collapse
    scored.sort((x, y) => y.score - x.score);
    const pick: (RankedHit & { _i: number })[] = [];

    for (const h of scored as (RankedHit & { _i: number })[]) {
      if (pick.every(p => this.rowDot(h._i, p._i) < m.dedupCosine)) pick.push(h);
      if (pick.length >= returnK) break;
    }

    return pick.map(({ row, score }) => ({ row, score }));
  }

  /** Top `perDomainK` memories from every domain, each domain ranked on its own. */
  searchPerDomain(context: string[], today: string, perDomainK = this.model.returnK): RankedHit[] {
    const domains = [...new Set(this.rows.map(r => r.domain))];

    return domains.flatMap(domain => this.search(context, today, perDomainK, domain));
  }
}
