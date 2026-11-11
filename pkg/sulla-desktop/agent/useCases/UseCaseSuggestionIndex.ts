// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { recallTokenize } from '../memory/rankedRecall';
import { PotionEmbedder } from '../memory/potionEmbedder';
import { PostgresUseCaseCatalogSource, type SuggestionSqlClient } from './PostgresUseCaseCatalogSource';

export type UseCaseType = 'skill' | 'agent' | 'workflow' | 'function' | 'recipe';
export type UseCaseChange = 'published' | 'installed' | 'updated' | 'deleted';
export interface UseCaseChangeEvent { type: UseCaseType; slug: string; change: UseCaseChange }
export interface UseCaseSuggestion { type: UseCaseType; slug: string; title: string; description: string; score: number; reason: string }
export interface UseCaseCatalogItem extends Omit<UseCaseSuggestion, 'score' | 'reason'> { triggers?: string[]; tags?: string[] }
export interface UseCaseCatalogSource { listPublished(): Promise<UseCaseCatalogItem[]>; findPublished(type: UseCaseType, slug: string): Promise<UseCaseCatalogItem | null> }
export interface UseCaseChangeNotifier { subscribe(listener: (event: UseCaseChangeEvent) => void): () => void }
export interface SuggestionEmbedder { readonly dim: number; embed(text: string): Float32Array }
export interface SuggestionLogger { info(message: string): void }

/** Constructor-owned event listeners; no process-global notification state. */
export class LocalUseCaseChangeNotifier implements UseCaseChangeNotifier {
  private readonly listeners = new Set<(event: UseCaseChangeEvent) => void>();
  subscribe(listener: (event: UseCaseChangeEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: UseCaseChangeEvent): void { for (const listener of this.listeners) listener(event); }
}

interface IndexedItem { item: UseCaseCatalogItem; vector: Float32Array; tokens: Set<string> }
export interface SuggestionOptions { types?: UseCaseType[]; limit?: number; minScore?: number }

/** In-memory, incrementally maintained vector/lexical catalog. */
export class UseCaseSuggestionIndex {
  private readonly items = new Map<string, IndexedItem>();
  private ready = false;
  private keywordOnly = false;
  private embedder?: SuggestionEmbedder;
  private unsubscribe?: () => void;
  constructor(
    private readonly embedderLoader: () => Promise<SuggestionEmbedder>,
    private readonly source: UseCaseCatalogSource,
    notifier: UseCaseChangeNotifier,
    private readonly logger: SuggestionLogger = console,
    private readonly now: () => number = Date.now,
  ) {
    this.unsubscribe = notifier.subscribe(event => { void this.applyChange(event); });
  }

  get rowCount(): number { return this.items.size; }

  async warm(): Promise<void> {
    if (this.ready) return;
    try {
      const rows = await this.source.listPublished();
      const embedder = await this.embedderLoader();
      this.embedder = embedder;
      for (const row of rows) this.upsert(row, embedder);
    } catch (error) {
      this.keywordOnly = true;
      this.items.clear();
      try { for (const row of await this.source.listPublished()) this.items.set(this.key(row.type, row.slug), { item: row, vector: new Float32Array(), tokens: this.tokens(row) }); }
      catch { /* catalog unavailable: an empty index is safe */ }
      this.logger.info(`[SuggestionIndex] embedder unavailable; keyword-only fallback (${String(error)})`);
    }
    this.ready = true;
  }

  async suggest(text: string, options: SuggestionOptions = {}): Promise<UseCaseSuggestion[]> {
    const started = this.now();
    if (!this.ready) await this.warm();
    const embedStart = this.now();
    let query: Float32Array | undefined;
    if (!this.keywordOnly) {
      try { this.embedder ??= await this.embedderLoader(); query = this.embedder.embed(text); }
      catch { this.keywordOnly = true; }
    }
    const embedMs = this.now() - embedStart;
    const rankStart = this.now();
    const queryTokens = new Set(recallTokenize(text));
    const candidates = [...this.items.values()].filter(({ item }) => !options.types || options.types.includes(item.type));
    const vectorScores = candidates.map(({ vector }) => query && vector.length ? this.cosine(query, vector) : 0);
    const keywordScores = candidates.map(({ tokens }) => {
      let count = 0; for (const token of queryTokens) if (tokens.has(token)) count++;
      return queryTokens.size ? count / queryTokens.size : 0;
    });
    const vectorOrder = [...candidates.keys()].sort((a, b) => vectorScores[b] - vectorScores[a]);
    const keywordOrder = [...candidates.keys()].sort((a, b) => keywordScores[b] - keywordScores[a]);
    const ranked = candidates.map((entry, i) => {
      const vr = vectorOrder.indexOf(i); const kr = keywordOrder.indexOf(i);
      const score = query ? 1 / (60 + vr + 1) + 1 / (60 + kr + 1) : keywordScores[i];
      const reason = keywordScores[i] > vectorScores[i] ? 'keyword match' : 'semantic match';
      return { ...entry.item, score, reason };
    }).filter(row => row.score >= (options.minScore ?? 0)).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(50, options.limit ?? 8)));
    const rankMs = this.now() - rankStart;
    this.logger.info(`[SuggestionTiming] embedMs=${embedMs} rankMs=${rankMs} totalMs=${this.now() - started} rows=${candidates.length} mode=${query ? 'vector' : 'keyword'}`);
    return ranked;
  }

  dispose(): void { this.unsubscribe?.(); this.unsubscribe = undefined; }
  private async applyChange(event: UseCaseChangeEvent): Promise<void> {
    try { await this.applyChangeSafely(event); } catch (error) { this.logger.info(`[SuggestionIndex] change event failed (${String(error)})`); }
  }
  private async applyChangeSafely(event: UseCaseChangeEvent): Promise<void> {
    const key = this.key(event.type, event.slug);
    if (event.change === 'deleted') { this.items.delete(key); return; }
    const item = await this.source.findPublished(event.type, event.slug);
    if (!item) { this.items.delete(key); return; }
    if (this.keywordOnly) { this.items.set(key, { item, vector: new Float32Array(), tokens: this.tokens(item) }); return; }
    try { this.embedder ??= await this.embedderLoader(); this.upsert(item, this.embedder); }
    catch { this.keywordOnly = true; this.items.set(key, { item, vector: new Float32Array(), tokens: this.tokens(item) }); }
  }
  private upsert(item: UseCaseCatalogItem, embedder: SuggestionEmbedder): void {
    const text = this.document(item);
    this.items.set(this.key(item.type, item.slug), { item, vector: embedder.embed(text), tokens: this.tokens(item) });
  }
  private document(item: UseCaseCatalogItem): string { return [item.title, item.description, ...(item.triggers ?? []), ...(item.tags ?? [])].join(' '); }
  private tokens(item: UseCaseCatalogItem): Set<string> { return new Set(recallTokenize(`${item.slug} ${this.document(item)}`)); }
  private key(type: UseCaseType, slug: string): string { return `${type}:${slug}`; }
  private cosine(a: Float32Array, b: Float32Array): number { let sum = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) sum += a[i] * b[i]; return sum; }
}

export const potionSuggestionEmbedderLoader = async (): Promise<PotionEmbedder> => {
  const { resolveBundledModelDir } = await import('../utils/sullaPaths');
  const dir = resolveBundledModelDir('potion-retrieval-32M');
  if (!dir) throw new Error('Potion retrieval model directory unavailable');
  return PotionEmbedder.load(dir);
};

/** Main-process composition root; S3 can expose index.query over IPC without duplicating state. */
export class UseCaseSuggestionCompositionRoot {
  readonly notifier = new LocalUseCaseChangeNotifier();
  readonly index: UseCaseSuggestionIndex;
  constructor(db: SuggestionSqlClient, builtinSkillSlugs: readonly string[] = []) {
    const source = new PostgresUseCaseCatalogSource(db, builtinSkillSlugs);
    this.index = new UseCaseSuggestionIndex(potionSuggestionEmbedderLoader, source, this.notifier);
  }
  start(): void { void this.index.warm(); }
  stop(): void { this.index.dispose(); }
}
