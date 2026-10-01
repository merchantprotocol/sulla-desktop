import fs from 'fs';
import os from 'os';
import path from 'path';

import { convertSafetensorsToInt8 } from '../../../../../scripts/dependencies/potion-convert';
import { PotionEmbedder, bertNormalize, bertPreTokenize } from '../potionEmbedder';
import { DEFAULT_RANKER, MemoryRow, RankedRecallIndex, recallTokenize } from '../rankedRecall';

const VOCAB = ['[PAD]', '[UNK]', 'merge', 'pr', '##s', 'squash', 'sulla', 'deploy', 'cloud', '##flare', 'invoice', 'bread', 'route', 'hello', 'world', ',', '!'];
const DIM = 8;

/** Deterministic synthetic table: token i gets a one-hot-ish row so meanings are separable. */
function syntheticTable(): Float32Array {
  const t = new Float32Array(VOCAB.length * DIM);

  VOCAB.forEach((_, i) => { t[i * DIM + (i % DIM)] = 1; t[i * DIM + ((i * 3) % DIM)] += 0.5 });

  return t;
}

function writeModel(dir: string): void {
  const table = syntheticTable();
  const header = JSON.stringify({ embeddings: { dtype: 'F32', shape: [VOCAB.length, DIM], data_offsets: [0, table.byteLength] } });
  const len = Buffer.alloc(8);

  len.writeBigUInt64LE(BigInt(header.length));
  const st = path.join(dir, 'model.safetensors');

  fs.writeFileSync(st, Buffer.concat([len, Buffer.from(header), Buffer.from(table.buffer)]));
  convertSafetensorsToInt8(st, path.join(dir, 'model.int8.bin'));
  fs.writeFileSync(path.join(dir, 'tokenizer.json'), JSON.stringify({ model: { type: 'WordPiece', vocab: Object.fromEntries(VOCAB.map((t, i) => [t, i])) } }));
}

describe('potion embedder', () => {
  let dir: string;
  let emb: PotionEmbedder;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potion-test-'));
    writeModel(dir);
    emb = PotionEmbedder.load(dir);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('normalizes and pre-tokenizes like BERT', () => {
    expect(bertNormalize('Héllo,\tWORLD!')).toBe('hello, world!');
    expect(bertPreTokenize('hello, world!')).toEqual(['hello', ',', 'world', '!']);
  });

  it('applies WordPiece with ## continuations and drops unknown words', () => {
    expect(emb.tokenIds('Merge PRs to Cloudflare')).toEqual([2, 3, 4, 8, 9]);
    expect(emb.tokenIds('zzzz')).toEqual([]);
  });

  it('round-trips the int8 table and returns unit vectors', () => {
    const v = emb.embed('squash merge');
    const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));

    expect(norm).toBeCloseTo(1, 5);
    expect(Array.from(emb.embed('zzzz')).every(x => x === 0)).toBe(true);
  });
});

describe('ranked recall index', () => {
  let dir: string;
  let emb: PotionEmbedder;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potion-test-'));
    writeModel(dir);
    emb = PotionEmbedder.load(dir);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const rows: MemoryRow[] = [
    { id: 'a1', domain: 'agent', level: 3, date: '2026-09-20', content: 'Squash merge Sulla PRs so main history stays clean.' },
    { id: 'a2', domain: 'agent', level: 3, date: '2026-09-21', content: 'Squash merge Sulla PRs; so main history stays clean.' },
    { id: 'p1', domain: 'projects', level: 2, date: '2026-09-25', content: 'Deploy the route app to Cloudflare.' },
    { id: 'o1', domain: 'observation', level: null, date: '2026-09-28', content: 'Bread invoice totals for the route.' },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `h${ i }`, domain: 'human', level: 1, date: '2026-08-01', content: `hello world note ${ i }` })),
  ];

  it('tokenizes for BM25 with stopwords and light stemming', () => {
    expect(recallTokenize('Merging the PRs into <x>ignored</x> main https://x.y')).toEqual(['merg', 'prs', 'main']);
  });

  it('ranks across domains, returns at most 16, and every hit is dated', () => {
    const index = new RankedRecallIndex(rows, emb);
    const hits = index.search(['merge the sulla PRs'], '2026-09-30');

    expect(hits.length).toBeLessThanOrEqual(DEFAULT_RANKER.returnK);
    expect(DEFAULT_RANKER.returnK).toBe(16);
    expect(hits[0].row.id).toMatch(/^a[12]$/);
    expect(hits.every(h => /^\d{4}-\d{2}-\d{2}$/.test(h.row.date))).toBe(true);
    expect(new Set(hits.map(h => h.row.domain)).size).toBeGreaterThan(1);
  });

  it('collapses near-duplicate memories', () => {
    const index = new RankedRecallIndex(rows, emb);
    const ids = index.search(['merge the sulla PRs'], '2026-09-30').map(h => h.row.id);

    expect(ids.filter(id => id === 'a1' || id === 'a2')).toHaveLength(1);
  });

  it('returns up to 16 per domain so a busy domain cannot crowd out the rest', () => {
    // the filler rows embed identically, so disable dedup to test the cap alone
    const index = new RankedRecallIndex(rows, emb, { ...DEFAULT_RANKER, dedupCosine: 1.01 });
    const hits = index.searchPerDomain(['hello world merge the sulla PRs'], '2026-09-30');
    const count = (d: string) => hits.filter(h => h.row.domain === d).length;

    expect(count('human')).toBe(16);
    expect(count('agent')).toBe(2);
    expect(count('projects')).toBe(1);
    expect(count('observation')).toBe(1);
    expect(index.search(['hello world merge the sulla PRs'], '2026-09-30', 16, 'human').every(h => h.row.domain === 'human')).toBe(true);
  });

  it('returns nothing for empty context', () => {
    expect(new RankedRecallIndex(rows, emb).search(['   '], '2026-09-30')).toEqual([]);
  });
});
