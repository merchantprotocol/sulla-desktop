// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { recallTokenize } from '../memory/rankedRecall';
import { PotionEmbedder } from '../memory/potionEmbedder';
import { PostgresUseCaseCatalogSource, type SuggestionSqlClient } from './PostgresUseCaseCatalogSource';
import { UseCaseChangeBus, type UseCaseChangeTransport } from './UseCaseChangeBus';

export type UseCaseType = 'skill' | 'agent' | 'workflow' | 'function' | 'recipe';
export type UseCaseChange = 'published' | 'installed' | 'updated' | 'deleted';
export interface UseCaseChangeEvent { type: UseCaseType; slug: string; change: UseCaseChange }
/** Safe declared-input metadata: never values, defaults or credentials. */
export interface UseCaseInput { name: string; label?: string; required?: boolean }
/**
 * `score` is in [0, 1]. In `semantic` mode it is the query/use-case cosine
 * similarity with a small exact-word bonus; in `keyword` mode (embedder
 * unavailable only) it is the share of query words the use case contains.
 * Only rows at or above the mode's threshold are ever returned.
 */
export interface UseCaseSuggestion { type: UseCaseType; slug: string; title: string; description: string; score: number; reason: 'semantic match' | 'keyword match'; inputs?: UseCaseInput[] }
export interface UseCaseCatalogItem { type: UseCaseType; slug: string; title: string; description: string; inputs?: UseCaseInput[]; triggers?: string[]; tags?: string[] }
export interface UseCaseCatalogSource {
  listPublished(): Promise<UseCaseCatalogItem[]>;
  findPublished(type: UseCaseType, slug: string): Promise<UseCaseCatalogItem | null>;
  /** Optional cheap content hash of the published catalog, used to reconcile writes that emitted no event. */
  fingerprint?(): Promise<string>;
}
export interface UseCaseChangeNotifier { subscribe(listener: (event: UseCaseChangeEvent) => void): () => void }
export interface SuggestionEmbedder { readonly dim: number; embed(text: string): Float32Array }
export interface SuggestionLogger { info(message: string): void }
export type SuggestionMode = 'cold' | 'semantic' | 'keyword';

export const USE_CASE_TYPES: readonly UseCaseType[] = ['skill', 'agent', 'workflow', 'function', 'recipe'];

/** Constructor-owned event listeners; no process-global notification state. */
export class LocalUseCaseChangeNotifier implements UseCaseChangeNotifier {
  private readonly listeners = new Set<(event: UseCaseChangeEvent) => void>();
  constructor(private readonly logger: SuggestionLogger = console) {}
  subscribe(listener: (event: UseCaseChangeEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /** Never throws: callers emit after their database commit and must not report a committed write as failed. */
  emit(event: UseCaseChangeEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch (error) { this.logger.info(`[SuggestionIndex] change listener failed (${ String(error) })`); }
    }
  }
}

export interface SuggestionOptions {
  types?:        UseCaseType[];
  /** Restrict results to these slugs. Applied before `limit`; an empty list returns nothing. */
  allowedSlugs?: string[];
  /** 1..50, default 8. */
  limit?:        number;
  /** Overrides the active mode's threshold, 0..1. */
  minScore?:     number;
}

export interface SuggestionIndexTuning {
  /** Minimum semantic score; below it the query is treated as unrelated and nothing is suggested. */
  semanticThreshold:  number;
  /** Minimum share of query words matched when the embedder is unavailable. */
  keywordThreshold:   number;
  /** Weight of the exact-word bonus in a semantic score. */
  keywordBonus:       number;
  catalogRetryMinMs:  number;
  catalogRetryMaxMs:  number;
  embedderRetryMs:    number;
  reconcileEveryMs:   number;
}

export const DEFAULT_SUGGESTION_TUNING: SuggestionIndexTuning = {
  semanticThreshold: 0.35,
  keywordThreshold:  0.5,
  keywordBonus:      0.15,
  catalogRetryMinMs: 1_000,
  catalogRetryMaxMs: 60_000,
  embedderRetryMs:   60_000,
  reconcileEveryMs:  15_000,
};

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 8;
const MAX_ALLOWED_SLUGS = 2_000;
const MAX_SLUG_LENGTH = 200;

interface IndexedItem { item: UseCaseCatalogItem; document: string; vector?: Float32Array; tokens: Set<string> }
interface NormalizedOptions { types?: Set<UseCaseType>; allowedSlugs?: Set<string>; limit: number; minScore?: number }
interface Scored { entry: IndexedItem; score: number; keyword: number }

/**
 * Instance-owned, incrementally maintained vector catalog of published use
 * cases. Every catalog mutation (initial load, retry, change event,
 * reconciliation, embedder upgrade) runs on one serial queue, so a slow load
 * can never overwrite a newer delete or update.
 */
export class UseCaseSuggestionIndex {
  private items = new Map<string, IndexedItem>();
  private loaded = false;
  private catalogFingerprint?: string;
  private catalogFailures = 0;
  private catalogRetryAt = 0;
  private nextReconcileAt = 0;
  private reconcileQueued = false;
  private upgradeQueued = false;
  private missingVectors = false;
  private warmPromise?: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();
  private embedder?: SuggestionEmbedder;
  private embedderLoad?: Promise<SuggestionEmbedder | undefined>;
  private embedderRetryAt = 0;
  private embedderUnavailable = false;
  private unsubscribe?: () => void;
  private readonly tuning: SuggestionIndexTuning;

  constructor(
    private readonly embedderLoader: () => Promise<SuggestionEmbedder>,
    private readonly source: UseCaseCatalogSource,
    notifier: UseCaseChangeNotifier,
    private readonly logger: SuggestionLogger = console,
    private readonly now: () => number = Date.now,
    tuning: Partial<SuggestionIndexTuning> = {},
  ) {
    this.tuning = { ...DEFAULT_SUGGESTION_TUNING, ...tuning };
    this.unsubscribe = notifier.subscribe(event => { void this.enqueue(() => this.applyChange(event)); });
  }

  get rowCount(): number { return this.items.size; }
  get isReady(): boolean { return this.loaded; }
  get mode(): SuggestionMode { return !this.loaded ? 'cold' : this.embedderUnavailable ? 'keyword' : 'semantic'; }
  get thresholds(): { semantic: number; keyword: number } { return { semantic: this.tuning.semanticThreshold, keyword: this.tuning.keywordThreshold }; }

  /**
   * Load the published catalog. Concurrent callers share one load. A catalog
   * failure leaves the index cold (not empty-and-ready) and retries with
   * backoff on a later call; it never switches to keyword mode.
   */
  warm(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.warmPromise) return this.warmPromise;
    if (this.now() < this.catalogRetryAt) return Promise.resolve();
    const pending = this.enqueue(() => this.loadCatalog()).finally(() => { if (this.warmPromise === pending) this.warmPromise = undefined; });
    this.warmPromise = pending;
    return pending;
  }

  async suggest(text: string, options: SuggestionOptions = {}): Promise<UseCaseSuggestion[]> {
    const started = this.now();
    const opts = this.normalizeOptions(options);
    if (!this.loaded) await this.warm();
    if (!this.loaded) {
      this.logger.info(`[SuggestionTiming] embedMs=0 rankMs=0 totalMs=${ this.now() - started } rows=0 mode=cold`);
      return [];
    }
    this.scheduleReconcile();
    this.scheduleVectorUpgrade();

    const embedStart = this.now();
    const query = this.embedQuery(text);
    const embedMs = this.now() - embedStart;

    const rankStart = this.now();
    const queryTokens = new Set(recallTokenize(text));
    const semantic = Boolean(query);
    const threshold = opts.minScore ?? (semantic ? this.tuning.semanticThreshold : this.tuning.keywordThreshold);
    const top: Scored[] = [];
    let considered = 0;
    if (queryTokens.size || query) {
      for (const entry of this.items.values()) {
        if (opts.types && !opts.types.has(entry.item.type)) continue;
        if (opts.allowedSlugs && !opts.allowedSlugs.has(entry.item.slug)) continue;
        considered++;
        const keyword = this.keywordCoverage(queryTokens, entry.tokens);
        const score = query ? this.semanticScore(query, entry, keyword) : keyword;
        if (score >= threshold && score > 0) this.insertTop(top, { entry, score, keyword }, opts.limit);
      }
    }
    const results = top.map(({ entry, score }) => this.toSuggestion(entry.item, score, semantic));
    const rankMs = this.now() - rankStart;
    this.logger.info(`[SuggestionTiming] embedMs=${ embedMs } rankMs=${ rankMs } totalMs=${ this.now() - started } rows=${ considered } hits=${ results.length } mode=${ semantic ? 'semantic' : 'keyword' }`);
    return results;
  }

  /**
   * Re-check the catalog now (fingerprint compare, then rebuild if changed).
   * Queued behind any in-flight load, so it always runs against a snapshot
   * that predates the call. Used once the change subscription is live, to
   * catch writes whose events fired before anyone was listening.
   */
  refresh(): Promise<void> {
    return this.enqueue(async() => {
      if (!this.loaded) return;
      if (this.source.fingerprint) { await this.reconcile(); return; }
      this.items = this.build(await this.source.listPublished(), await this.getEmbedder(), this.items);
    });
  }

  dispose(): void { this.unsubscribe?.(); this.unsubscribe = undefined; }

  // ── mutation queue ────────────────────────────────────────────────────

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.mutationTail.then(task, task);
    this.mutationTail = run.catch(error => { this.logger.info(`[SuggestionIndex] catalog update failed (${ String(error) })`); });
    return this.mutationTail;
  }

  private async loadCatalog(): Promise<void> {
    if (this.loaded) return;
    try {
      // Fingerprint first: a write landing between the two reads shows up as a mismatch on the next reconcile.
      const fingerprint = await this.source.fingerprint?.();
      const rows = await this.source.listPublished();
      const embedder = await this.getEmbedder();
      this.items = this.build(rows, embedder, new Map());
      this.catalogFingerprint = fingerprint;
      this.loaded = true;
      this.catalogFailures = 0;
      this.nextReconcileAt = this.now() + this.tuning.reconcileEveryMs;
    } catch (error) {
      this.catalogFailures++;
      const delay = Math.min(this.tuning.catalogRetryMaxMs, this.tuning.catalogRetryMinMs * 2 ** (this.catalogFailures - 1));
      this.catalogRetryAt = this.now() + delay;
      this.logger.info(`[SuggestionIndex] catalog unavailable; staying cold, retry in ${ delay }ms (${ String(error) })`);
    }
  }

  private async applyChange(event: UseCaseChangeEvent): Promise<void> {
    // A cold index reads the whole catalog fresh on load; nothing to patch.
    if (!this.loaded) return;
    const key = this.key(event.type, event.slug);
    try {
      const item = event.change === 'deleted' ? null : await this.source.findPublished(event.type, event.slug);
      if (!item) { this.items.delete(key); return; }
      const entry = this.index(item, await this.getEmbedder(), this.items.get(key));
      this.missingVectors ||= !entry.vector;
      this.items.set(key, entry);
    } catch (error) {
      // Force the next reconcile to compare against the database.
      this.catalogFingerprint = undefined;
      this.nextReconcileAt = 0;
      throw error;
    }
  }

  private scheduleReconcile(): void {
    if (!this.source.fingerprint || this.reconcileQueued || this.now() < this.nextReconcileAt) return;
    this.reconcileQueued = true;
    void this.enqueue(() => this.reconcile()).finally(() => { this.reconcileQueued = false; });
  }

  /** Catches definition CRUD that bypassed the change notifier (UI edits, agent tools, direct SQL). */
  private async reconcile(): Promise<void> {
    this.nextReconcileAt = this.now() + this.tuning.reconcileEveryMs;
    const fingerprint = await this.source.fingerprint!();
    if (fingerprint === this.catalogFingerprint) return;
    const rows = await this.source.listPublished();
    this.items = this.build(rows, await this.getEmbedder(), this.items);
    this.catalogFingerprint = fingerprint;
    this.logger.info(`[SuggestionIndex] reconciled catalog (${ this.items.size } rows)`);
  }

  /**
   * Reload a lost embedder (failed load or a query-time embed error) once its
   * retry is due, and give vectorless rows their vectors. Queries never wait on it.
   */
  private scheduleVectorUpgrade(): void {
    if (this.upgradeQueued || (this.embedder && !this.missingVectors)) return;
    if (!this.embedder && this.embedderUnavailable && this.now() < this.embedderRetryAt) return;
    this.upgradeQueued = true;
    void this.enqueue(() => this.upgradeVectors()).finally(() => { this.upgradeQueued = false; });
  }

  private async upgradeVectors(): Promise<void> {
    const embedder = await this.getEmbedder();
    if (!embedder || !this.missingVectors) return;
    this.items = this.build([...this.items.values()].map(entry => entry.item), embedder, this.items);
  }

  // ── embedder ──────────────────────────────────────────────────────────

  /** Returns the embedder, or undefined while it is unavailable (the only keyword-fallback trigger). */
  private async getEmbedder(): Promise<SuggestionEmbedder | undefined> {
    if (this.embedder) return this.embedder;
    if (this.embedderUnavailable && this.now() < this.embedderRetryAt) return undefined;
    this.embedderLoad ??= this.embedderLoader().then(
      embedder => { this.embedder = embedder; this.embedderUnavailable = false; return embedder; },
      error => { this.markEmbedderUnavailable(error); return undefined; },
    ).finally(() => { this.embedderLoad = undefined; });
    return this.embedderLoad;
  }

  private markEmbedderUnavailable(error: unknown): void {
    this.embedder = undefined;
    this.embedderUnavailable = true;
    this.embedderRetryAt = this.now() + this.tuning.embedderRetryMs;
    this.logger.info(`[SuggestionIndex] embedder unavailable; keyword fallback until retry (${ String(error) })`);
  }

  private embedQuery(text: string): Float32Array | undefined {
    if (!this.embedder || !text.trim()) return undefined;
    try { return this.embedder.embed(text); } catch (error) { this.markEmbedderUnavailable(error); return undefined; }
  }

  // ── indexing & ranking ────────────────────────────────────────────────

  private build(rows: UseCaseCatalogItem[], embedder: SuggestionEmbedder | undefined, previous: Map<string, IndexedItem>): Map<string, IndexedItem> {
    const next = new Map<string, IndexedItem>();
    let missing = false;
    for (const row of rows) {
      const key = this.key(row.type, row.slug);
      const entry = this.index(row, embedder, previous.get(key));
      missing ||= !entry.vector;
      next.set(key, entry);
    }
    this.missingVectors = missing;
    return next;
  }

  private index(item: UseCaseCatalogItem, embedder: SuggestionEmbedder | undefined, previous?: IndexedItem): IndexedItem {
    const document = [item.title, item.description, ...(item.triggers ?? []), ...(item.tags ?? [])].join(' ');
    const tokens = new Set(recallTokenize(`${ item.slug } ${ document }`));
    if (previous?.vector && previous.document === document) return { item, document, vector: previous.vector, tokens };
    let vector: Float32Array | undefined;
    if (embedder) {
      try { vector = embedder.embed(document); } catch (error) { this.markEmbedderUnavailable(error); }
    }
    return { item, document, vector, tokens };
  }

  private semanticScore(query: Float32Array, entry: IndexedItem, keyword: number): number {
    if (!entry.vector) return 0;
    const cosine = Math.max(0, Math.min(1, this.dot(query, entry.vector)));
    return Math.min(1, cosine * (1 - this.tuning.keywordBonus) + keyword * this.tuning.keywordBonus);
  }

  private keywordCoverage(query: Set<string>, tokens: Set<string>): number {
    if (!query.size) return 0;
    let hits = 0;
    for (const token of query) if (tokens.has(token)) hits++;
    return hits / query.size;
  }

  /** Bounded descending insert: O(n·k) with k ≤ 50, no full sort and no indexOf. */
  private insertTop(top: Scored[], candidate: Scored, limit: number): void {
    if (top.length >= limit && candidate.score <= top[top.length - 1].score) return;
    let i = top.length;
    while (i > 0 && top[i - 1].score < candidate.score) i--;
    top.splice(i, 0, candidate);
    if (top.length > limit) top.pop();
  }

  private toSuggestion(item: UseCaseCatalogItem, score: number, semantic: boolean): UseCaseSuggestion {
    const suggestion: UseCaseSuggestion = { type: item.type, slug: item.slug, title: item.title, description: item.description, score: Math.round(score * 1000) / 1000, reason: semantic ? 'semantic match' : 'keyword match' };
    if (item.inputs?.length) suggestion.inputs = item.inputs.map(input => ({ ...input }));
    return suggestion;
  }

  private normalizeOptions(options: SuggestionOptions): NormalizedOptions {
    let types: Set<UseCaseType> | undefined;
    if (options.types !== undefined) {
      if (!Array.isArray(options.types) || options.types.some(type => !USE_CASE_TYPES.includes(type))) throw new Error(`types must be a subset of ${ USE_CASE_TYPES.join(', ') }`);
      types = new Set(options.types);
    }
    let allowedSlugs: Set<string> | undefined;
    if (options.allowedSlugs !== undefined) {
      const slugs = options.allowedSlugs;
      if (!Array.isArray(slugs) || slugs.length > MAX_ALLOWED_SLUGS || slugs.some(slug => typeof slug !== 'string' || !slug || slug.length > MAX_SLUG_LENGTH)) {
        throw new Error(`allowedSlugs must be at most ${ MAX_ALLOWED_SLUGS } non-empty strings`);
      }
      allowedSlugs = new Set(slugs);
    }
    const rawLimit = Number(options.limit ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(rawLimit))) : DEFAULT_LIMIT;
    const minScore = options.minScore === undefined || !Number.isFinite(options.minScore) ? undefined : Math.max(0, Math.min(1, options.minScore));
    return { types, allowedSlugs, limit, minScore };
  }

  private key(type: UseCaseType, slug: string): string { return `${ type }:${ slug }`; }
  private dot(a: Float32Array, b: Float32Array): number { let sum = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) sum += a[i] * b[i]; return sum; }
}

export const potionSuggestionEmbedderLoader = async(): Promise<PotionEmbedder> => {
  const { resolveBundledModelDir } = await import('../utils/sullaPaths');
  const dir = resolveBundledModelDir('potion-retrieval-32M');
  if (!dir) throw new Error('Potion retrieval model directory unavailable');
  return PotionEmbedder.load(dir);
};

/**
 * Main-process composition root: owns the one bus + index pair. The bus
 * hears writers in this process directly and every other writer (models,
 * agent tools, other processes) over the injected transport.
 */
export class UseCaseSuggestionCompositionRoot {
  readonly notifier: UseCaseChangeBus;
  readonly index: UseCaseSuggestionIndex;
  constructor(db: SuggestionSqlClient, builtinSkillSlugs: readonly string[], transport: UseCaseChangeTransport, embedderLoader: () => Promise<SuggestionEmbedder> = potionSuggestionEmbedderLoader) {
    this.notifier = new UseCaseChangeBus(transport);
    this.index = new UseCaseSuggestionIndex(embedderLoader, new PostgresUseCaseCatalogSource(db, builtinSkillSlugs), this.notifier);
  }
  /**
   * Warm immediately (suggestions must not wait on Redis), and refresh once the
   * subscription is live: any write whose event fired before then is caught by
   * that fingerprint check instead of waiting for the 15 s backstop.
   */
  start(): void {
    void this.index.warm();
    void this.notifier.start().then(() => this.index.refresh());
  }
  stop(): void { this.index.dispose(); void this.notifier.stop(); }
}
