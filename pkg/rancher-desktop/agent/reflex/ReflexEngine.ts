/**
 * ReflexEngine — Sulla Desktop's native decision engine.
 *
 * Pure TypeScript, no model and no I/O: given the training examples stored in
 * Postgres (reflex_examples), it decides whether a user message maps to ONE
 * concrete tool call it has seen succeed for similar messages before.
 *
 * Method: TF-IDF weighted token/bigram vectors + cosine nearest-neighbour
 * voting. Each example votes for its (tool, params) "decision" with weight =
 * similarity; negative examples vote against the decision they name; examples
 * with tool = 'none' vote for doing nothing. Confidence is
 *
 *     top_similarity × (winning_vote / total_vote)
 *
 * so the engine acts only when the message is close to something it knows AND
 * the neighbourhood agrees. Params are replayed verbatim from the winning
 * decision — the engine never invents arguments.
 */

import { canonicalize } from './reflexSynonyms';

export const REFLEX_NONE = 'none';

export interface ReflexExample {
  id:        string;
  utterance: string;
  toolName:  string;
  params:    Record<string, unknown>;
  /** false = "do NOT take this action for this utterance" */
  positive:  boolean;
}

export interface ReflexNeighbour {
  id:         string;
  utterance:  string;
  toolName:   string;
  positive:   boolean;
  similarity: number;
}

/** One (tool, params) decision the neighbourhood voted for. */
export interface ReflexCandidate {
  toolName:   string;
  params:     Record<string, unknown>;
  confidence: number;
  support:    number;
}

export interface ReflexPrediction {
  /** 'none' when the engine should not act */
  toolName:   string;
  params:     Record<string, unknown>;
  confidence: number;
  /** Similarity of the closest supporting example */
  similarity: number;
  /** Positive examples backing the winning decision */
  support:    number;
  neighbours: ReflexNeighbour[];
  /** Positive, non-'none' decisions ranked by vote — the winner first when it is an action */
  candidates: ReflexCandidate[];
  reason:     string;
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'is', 'are', 'be', 'it', 'this', 'that', 'these', 'those',
  'please', 'hey', 'hi', 'sulla', 'can', 'could', 'would', 'will', 'you', 'u', 'me', 'my', 'i', 'im', 'we', 'our',
  'just', 'go', 'ahead', 'real', 'quick', 'quickly', 'up', 'some', 'thanks', 'thank', 'ok', 'okay', 'so', 'now',
]);

/** Minimum cosine similarity for an example to count as a neighbour at all. */
const NEIGHBOUR_FLOOR = 0.25;
const MAX_NEIGHBOURS = 7;
const MAX_CANDIDATES = 3;
/** Messages longer than this are treated as conversation, not commands. */
export const MAX_COMMAND_TOKENS = 40;

function stem(token: string): string {
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export function tokenize(text: string): string[] {
  // Thesaurus first (reflexSynonyms), so every synonym lands on one feature.
  return canonicalize(text)
    .replace(/https?:\/\/\S+/g, (url) => ` ${ url.replace(/[^a-z0-9]+/g, ' ') } `)
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(t => t && !STOPWORDS.has(t))
    .map(stem);
}

function features(text: string): string[] {
  const tokens = tokenize(text);
  const out = [...tokens];
  for (let i = 0; i < tokens.length - 1; i++) out.push(`${ tokens[i] }_${ tokens[i + 1] }`);
  return out;
}

/** Stable key for a (tool, params) decision — key order independent. */
export function decisionKey(toolName: string, params: Record<string, unknown>): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as object).sort().map(k => [k, canon((v as any)[k])]));
    }
    return v;
  };
  return `${ toolName }:${ JSON.stringify(canon(params ?? {})) }`;
}

type Vector = Map<string, number>;

interface IndexedExample extends ReflexExample {
  vector: Vector;
  norm:   number;
  key:    string;
}

export class ReflexEngine {
  private examples: IndexedExample[] = [];
  private idf = new Map<string, number>();

  constructor(examples: ReflexExample[] = []) {
    this.train(examples);
  }

  get size(): number {
    return this.examples.length;
  }

  /** Rebuild the index from scratch. Cheap: O(examples × tokens). */
  train(examples: ReflexExample[]): void {
    const docFreq = new Map<string, number>();
    const tokenised = examples.map(e => ({ e, feats: features(e.utterance) }));
    for (const { feats } of tokenised) {
      for (const f of new Set(feats)) docFreq.set(f, (docFreq.get(f) ?? 0) + 1);
    }
    const n = Math.max(1, examples.length);
    this.idf = new Map([...docFreq].map(([f, df]) => [f, Math.log((n + 1) / (df + 1)) + 1]));
    this.examples = tokenised
      .map(({ e, feats }) => {
        const vector = this.vectorize(feats);
        return { ...e, vector, norm: norm(vector), key: decisionKey(e.toolName, e.params) };
      })
      .filter(e => e.norm > 0);
  }

  private vectorize(feats: string[]): Vector {
    const tf = new Map<string, number>();
    for (const f of feats) tf.set(f, (tf.get(f) ?? 0) + 1);
    const v: Vector = new Map();
    for (const [f, count] of tf) {
      // Unknown features get the max idf so novel words dilute similarity.
      const idf = this.idf.get(f) ?? Math.log(this.examples.length + 2) + 1;
      v.set(f, count * idf);
    }
    return v;
  }

  predict(message: string): ReflexPrediction {
    const empty = (reason: string, neighbours: ReflexNeighbour[] = []): ReflexPrediction => ({
      toolName: REFLEX_NONE, params: {}, confidence: 0, similarity: 0, support: 0, neighbours, candidates: [], reason,
    });

    const feats = features(message);
    if (feats.length === 0) return empty('no meaningful words');
    if (tokenize(message).length > MAX_COMMAND_TOKENS) return empty('message too long to be a single command');
    if (this.examples.length === 0) return empty('no training examples yet');

    const query = this.vectorize(feats);
    const qNorm = norm(query);
    const scored = this.examples
      .map(e => ({ e, sim: cosine(query, qNorm, e.vector, e.norm) }))
      .filter(s => s.sim >= NEIGHBOUR_FLOOR)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, MAX_NEIGHBOURS);

    const neighbours = scored.map(({ e, sim }) => ({
      id: e.id, utterance: e.utterance, toolName: e.toolName, positive: e.positive, similarity: round(sim),
    }));
    if (scored.length === 0) return empty('nothing similar has been learned', neighbours);

    // Tally votes per decision. Negatives subtract from the decision they name
    // and count toward total disagreement.
    const votes = new Map<string, { vote: number; top: number; support: number; toolName: string; params: Record<string, unknown> }>();
    let total = 0;
    for (const { e, sim } of scored) {
      total += sim;
      const slot = votes.get(e.key) ?? { vote: 0, top: 0, support: 0, toolName: e.toolName, params: e.params };
      if (e.positive) {
        slot.vote += sim;
        slot.support += 1;
        slot.top = Math.max(slot.top, sim);
      } else {
        slot.vote -= sim;
      }
      votes.set(e.key, slot);
    }

    const ranked = [...votes.values()].sort((a, b) => b.vote - a.vote);
    const best = ranked[0];
    if (!best || best.vote <= 0) return empty('similar examples say not to act', neighbours);

    const confidence = round(best.top * (best.vote / total));
    const candidates = ranked
      .filter(v => v.vote > 0 && v.toolName !== REFLEX_NONE)
      .slice(0, MAX_CANDIDATES)
      .map(v => ({ toolName: v.toolName, params: v.params, confidence: round(v.top * (v.vote / total)), support: v.support }));
    if (best.toolName === REFLEX_NONE) {
      return { ...empty('learned that similar messages need no action', neighbours), confidence, similarity: round(best.top), support: best.support };
    }
    return {
      toolName:   best.toolName,
      params:     best.params,
      confidence,
      similarity: round(best.top),
      support:    best.support,
      neighbours,
      candidates,
      reason:     `${ best.support } matching example(s), closest similarity ${ round(best.top) }`,
    };
  }
}

function norm(v: Vector): number {
  let s = 0;
  for (const x of v.values()) s += x * x;
  return Math.sqrt(s);
}

function cosine(a: Vector, aNorm: number, b: Vector, bNorm: number): number {
  if (!aNorm || !bNorm) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, x] of small) {
    const y = large.get(k);
    if (y) dot += x * y;
  }
  return dot / (aNorm * bNorm);
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
