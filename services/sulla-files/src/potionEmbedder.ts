import fs from 'node:fs';
import path from 'node:path';

const MAGIC = 'PTN1';
const MAX_TOKENS = 512;
const MAX_WORD_CHARS = 100;
const CONTROL_RE = /\p{C}/u;
const SPACE_SEP_RE = /\p{Zs}/u;
const PUNCT_RE = /\p{P}/u;
const WHITESPACE_RE = /\s/u;
const COMBINING_MARK_RE = /\p{Mn}/gu;

function isCjk(cp:number):boolean {
  return (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x20000 && cp <= 0x2A6DF) ||
    (cp >= 0x2A700 && cp <= 0x2B73F) || (cp >= 0x2B740 && cp <= 0x2B81F) || (cp >= 0x2B820 && cp <= 0x2CEAF) ||
    (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0x2F800 && cp <= 0x2FA1F);
}

function isPunct(ch:string):boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126) || PUNCT_RE.test(ch);
}

function normalize(text:string):string {
  let output = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0 || cp === 0xFFFD) continue;
    if (ch === '\t' || ch === '\n' || ch === '\r' || SPACE_SEP_RE.test(ch)) { output += ' '; continue; }
    if (CONTROL_RE.test(ch)) continue;
    output += isCjk(cp) ? ` ${ ch } ` : ch;
  }
  return output.toLowerCase().normalize('NFD').replace(COMBINING_MARK_RE, '');
}

function preTokenize(text:string):string[] {
  const words:string[] = []; let current = '';
  for (const ch of text) {
    if (WHITESPACE_RE.test(ch)) { if (current) words.push(current); current = ''; }
    else if (isPunct(ch)) { if (current) words.push(current); current = ''; words.push(ch); }
    else current += ch;
  }
  if (current) words.push(current);
  return words;
}

/** Exact PTN1/Potion algorithm used by agent/memory/potionEmbedder.ts. */
export class PotionEmbedder {
  readonly dim:number;
  private constructor(
    private readonly vocab:Map<string, number>, private readonly unkId:number, rows:number, dim:number,
    private readonly scales:Float32Array, private readonly data:Int8Array,
  ) {
    if (scales.length !== rows || data.length !== rows * dim) throw new Error('Potion table shape mismatch');
    this.dim = dim;
  }

  static load(modelDir:string):PotionEmbedder {
    const tokenizer = JSON.parse(fs.readFileSync(path.join(modelDir, 'tokenizer.json'), 'utf8'));
    const vocab = new Map<string, number>(Object.entries(tokenizer?.model?.vocab ?? {}));
    const buffer = fs.readFileSync(path.join(modelDir, 'model.int8.bin'));
    if (buffer.toString('latin1', 0, 4) !== MAGIC) throw new Error('Invalid Potion model');
    const rows = buffer.readUInt32LE(4); const dim = buffer.readUInt32LE(8); const scaleBytes = rows * 4;
    const scales = new Float32Array(rows); Buffer.from(scales.buffer).set(buffer.subarray(12, 12 + scaleBytes));
    const data = new Int8Array(rows * dim); Buffer.from(data.buffer).set(buffer.subarray(12 + scaleBytes));
    return new PotionEmbedder(vocab, vocab.get('[UNK]') ?? -1, rows, dim, scales, data);
  }

  private wordPiece(word:string, output:number[]):void {
    const chars = Array.from(word); if (chars.length > MAX_WORD_CHARS) return;
    const ids:number[] = []; let start = 0;
    while (start < chars.length) {
      let end = chars.length; let found = -1;
      while (start < end) {
        const id = this.vocab.get(`${ start ? '##' : '' }${ chars.slice(start, end).join('') }`);
        if (id !== undefined) { found = id; break; }
        end--;
      }
      if (found < 0) return;
      ids.push(found); start = end;
    }
    for (const id of ids) if (id !== this.unkId) output.push(id);
  }

  embed(text:string):Float32Array {
    const ids:number[] = [];
    for (const word of preTokenize(normalize(text))) { this.wordPiece(word, ids); if (ids.length >= MAX_TOKENS) break; }
    const vector = new Float32Array(this.dim); if (!ids.length) return vector;
    for (const id of ids.slice(0, MAX_TOKENS)) {
      const scale = this.scales[id]; const offset = id * this.dim;
      for (let d = 0; d < this.dim; d++) vector[d] += this.data[offset + d] * scale;
    }
    let norm = 0; for (const value of vector) norm += value * value; norm = Math.sqrt(norm);
    if (norm) for (let d = 0; d < vector.length; d++) vector[d] /= norm;
    return vector;
  }
}

export function vectorLiteral(vector:Float32Array):string { return `[${ Array.from(vector).join(',') }]`; }
export function cosine(a:Float32Array, raw:unknown):number {
  const b = Array.isArray(raw) ? raw : []; if (a.length !== b.length) return 0;
  let dot = 0; let norm = 0;
  for (let i = 0; i < a.length; i++) { const value = Number(b[i]); dot += a[i] * value; norm += value * value; }
  return norm ? dot / Math.sqrt(norm) : 0;
}
