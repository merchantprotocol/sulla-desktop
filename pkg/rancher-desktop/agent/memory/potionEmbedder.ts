/**
 * PotionEmbedder — static text embeddings from minishlab/potion-retrieval-32M
 * (model2vec, MIT license), used by ranked memory recall.
 *
 * A model2vec model has no transformer layers: an embedding is the mean of the
 * token rows of a fixed table, L2-normalized. That makes it cheap enough to
 * embed every memory row in-process (~1k rows in well under a second) without
 * onnxruntime or a native dependency.
 *
 * Exact algorithm (mirrors the lab reference `potion_ref.py`, which matched
 * fastembed's vectors at cosine ≥ 0.9995 on 400 real memories):
 *   1. BertNormalizer: drop control chars, whitespace → ' ', pad CJK chars,
 *      lowercase, NFD + strip combining marks.
 *   2. BertPreTokenizer: split on whitespace and punctuation.
 *   3. WordPiece greedy longest-match with '##' continuations; words > 100
 *      chars become [UNK]. [UNK] ids are dropped (model2vec behaviour).
 *   4. Mean of (int8 row × per-row scale), L2-normalize.
 *
 * On-disk format (`model.int8.bin`, written by scripts/dependencies/potion.ts):
 *   'PTN1' | uint32 rows | uint32 dim | float32 scales[rows] | int8 data[rows*dim]
 * int8 quantization (per-row absmax/127) measured no recall loss in the lab.
 */

import fs from 'fs';
import path from 'path';

const MAGIC = 'PTN1';
const MAX_TOKENS = 512;
const MAX_WORD_CHARS = 100;

const CONTROL_RE = /\p{C}/u;
const SPACE_SEP_RE = /\p{Zs}/u;
const PUNCT_RE = /\p{P}/u;
const WHITESPACE_RE = /\s/u;
const COMBINING_MARK_RE = /\p{Mn}/gu;

function isCjk(cp: number): boolean {
  return (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x20000 && cp <= 0x2A6DF) ||
    (cp >= 0x2A700 && cp <= 0x2B73F) || (cp >= 0x2B740 && cp <= 0x2B81F) || (cp >= 0x2B820 && cp <= 0x2CEAF) ||
    (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0x2F800 && cp <= 0x2FA1F);
}

function isPunct(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;

  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;

  return PUNCT_RE.test(ch);
}

export function bertNormalize(text: string): string {
  let out = '';

  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;

    if (cp === 0 || cp === 0xFFFD) continue;
    if (ch === '\t' || ch === '\n' || ch === '\r' || SPACE_SEP_RE.test(ch)) {
      out += ' ';
      continue;
    }
    if (CONTROL_RE.test(ch)) continue;
    out += isCjk(cp) ? ` ${ ch } ` : ch;
  }

  return out.toLowerCase().normalize('NFD').replace(COMBINING_MARK_RE, '');
}

export function bertPreTokenize(text: string): string[] {
  const words: string[] = [];
  let cur = '';

  for (const ch of text) {
    if (WHITESPACE_RE.test(ch)) {
      if (cur) { words.push(cur); cur = '' }
    } else if (isPunct(ch)) {
      if (cur) { words.push(cur); cur = '' }
      words.push(ch);
    } else {
      cur += ch;
    }
  }
  if (cur) words.push(cur);

  return words;
}

/** Truncate by code points (Python slicing semantics), not UTF-16 units. */
export function truncateCodePoints(text: string, max: number): string {
  if (text.length <= max) return text;
  const cps = Array.from(text);

  return cps.length <= max ? text : cps.slice(0, max).join('');
}

export class PotionEmbedder {
  readonly dim:            number;
  private readonly vocab:  Map<string, number>;
  private readonly unkId:  number;
  private readonly scales: Float32Array;
  private readonly data:   Int8Array;

  constructor(vocab: Map<string, number>, unkId: number, rows: number, dim: number, scales: Float32Array, data: Int8Array) {
    if (scales.length !== rows || data.length !== rows * dim) {
      throw new Error(`PotionEmbedder: table shape mismatch (rows=${ rows } dim=${ dim })`);
    }
    this.vocab = vocab;
    this.unkId = unkId;
    this.dim = dim;
    this.scales = scales;
    this.data = data;
  }

  static load(modelDir: string): PotionEmbedder {
    const tokenizer = JSON.parse(fs.readFileSync(path.join(modelDir, 'tokenizer.json'), 'utf8'));
    const vocabObj: Record<string, number> = tokenizer?.model?.vocab ?? {};
    const vocab = new Map(Object.entries(vocabObj));
    const unkId = vocab.get('[UNK]') ?? -1;

    const buf = fs.readFileSync(path.join(modelDir, 'model.int8.bin'));

    if (buf.toString('latin1', 0, 4) !== MAGIC) throw new Error(`PotionEmbedder: bad magic in ${ modelDir }/model.int8.bin`);
    const rows = buf.readUInt32LE(4);
    const dim = buf.readUInt32LE(8);
    const scalesBytes = rows * 4;
    // Copy into aligned buffers: Buffer slices from readFileSync may be pooled/unaligned.
    const scales = new Float32Array(rows);

    Buffer.from(scales.buffer).set(buf.subarray(12, 12 + scalesBytes));
    const data = new Int8Array(rows * dim);

    Buffer.from(data.buffer).set(buf.subarray(12 + scalesBytes, 12 + scalesBytes + rows * dim));

    return new PotionEmbedder(vocab, unkId, rows, dim, scales, data);
  }

  private wordPiece(word: string, out: number[]): void {
    const chars = Array.from(word);

    if (chars.length > MAX_WORD_CHARS) return; // whole word → [UNK], dropped
    const ids: number[] = [];
    let start = 0;

    while (start < chars.length) {
      let end = chars.length;
      let found = -1;

      while (start < end) {
        const piece = chars.slice(start, end).join('');
        const id = this.vocab.get(start === 0 ? piece : `##${ piece }`);

        if (id !== undefined) { found = id; break }
        end -= 1;
      }
      if (found < 0) return; // unmatched remainder → whole word is [UNK], dropped
      ids.push(found);
      start = end;
    }
    for (const id of ids) if (id !== this.unkId) out.push(id);
  }

  tokenIds(text: string): number[] {
    const ids: number[] = [];

    for (const word of bertPreTokenize(bertNormalize(text))) {
      this.wordPiece(word, ids);
      if (ids.length >= MAX_TOKENS) break;
    }

    return ids.slice(0, MAX_TOKENS);
  }

  /** L2-normalized embedding; all-zero when the text has no known tokens. */
  embed(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const ids = this.tokenIds(text);

    if (ids.length === 0) return v;
    for (const id of ids) {
      const s = this.scales[id];
      const off = id * this.dim;

      for (let d = 0; d < this.dim; d++) v[d] += this.data[off + d] * s;
    }
    let norm = 0;

    for (let d = 0; d < this.dim; d++) norm += v[d] * v[d];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let d = 0; d < this.dim; d++) v[d] /= norm;

    return v;
  }
}
