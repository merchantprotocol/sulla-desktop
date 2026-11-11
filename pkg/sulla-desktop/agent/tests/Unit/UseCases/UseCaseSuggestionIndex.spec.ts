// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { describe, expect, it, vi } from 'vitest';
import { LocalUseCaseChangeNotifier, UseCaseSuggestionIndex, type UseCaseCatalogItem, type UseCaseType } from '../../../useCases/UseCaseSuggestionIndex';

class FixtureCatalog {
  constructor(readonly rows: UseCaseCatalogItem[]) {}
  async listPublished(): Promise<UseCaseCatalogItem[]> { return [...this.rows]; }
  async findPublished(type: UseCaseType, slug: string): Promise<UseCaseCatalogItem | null> { return this.rows.find(row => row.type === type && row.slug === slug) ?? null; }
}
class FakeEmbedder {
  readonly dim = 3;
  embed(text: string): Float32Array { const v = new Float32Array(3); if (/calendar|meeting/.test(text)) v[0] = 1; else if (/mail|inbox/.test(text)) v[1] = 1; else v[2] = 1; return v; }
}
const item = (slug: string, description: string, type: UseCaseType = 'skill'): UseCaseCatalogItem => ({ type, slug, title: slug, description });

describe('UseCaseSuggestionIndex', () => {
  it('returns only catalog-provided published rows across types', async () => {
    // risk: permissions — unpublished drafts must never enter the agent's suggestions.
    const source = new FixtureCatalog([item('published', 'calendar meetings'), item('live-agent', 'calendar agent', 'agent')]);
    const index = new UseCaseSuggestionIndex(async () => new FakeEmbedder(), source, new LocalUseCaseChangeNotifier());
    expect((await index.suggest('calendar')).map(row => row.slug)).toEqual(['published', 'live-agent']);
  });
  it('uses vector ranking and exact lexical hits, then updates and deletes incrementally', async () => {
    // risk: data accuracy — stale/incorrect rankings can offer the wrong action.
    const events = new LocalUseCaseChangeNotifier(); const rows = [item('calendar-skill', 'calendar meetings'), item('mail-skill', 'mail inbox')];
    const source = new FixtureCatalog(rows); const load = vi.fn(async () => new FakeEmbedder());
    const index = new UseCaseSuggestionIndex(load, source, events);
    expect((await index.suggest('calendar meeting')).at(0)?.slug).toBe('calendar-skill');
    rows.push(item('calendar-report', 'calendar planning')); events.emit({ type: 'skill', slug: 'calendar-report', change: 'published' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await index.suggest('calendar planning')).some(row => row.slug === 'calendar-report')).toBe(true);
    rows.splice(rows.findIndex(row => row.slug === 'calendar-skill'), 1); rows.push(item('calendar-skill', 'sports scores')); events.emit({ type: 'skill', slug: 'calendar-skill', change: 'updated' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await index.suggest('mail inbox')).at(0)?.slug).toBe('mail-skill');
    rows.splice(rows.findIndex(row => row.slug === 'calendar-report'), 1); events.emit({ type: 'skill', slug: 'calendar-report', change: 'deleted' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await index.suggest('calendar planning')).some(row => row.slug === 'calendar-report')).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('falls back to keyword ranking when the embedder cannot load', async () => {
    // risk: availability — retrieval should remain usable without model weights.
    const index = new UseCaseSuggestionIndex(async () => { throw new Error('weights missing'); }, new FixtureCatalog([item('calendar-helper', 'calendar meeting workflow'), item('mail-helper', 'mail inbox')]), new LocalUseCaseChangeNotifier());
    expect((await index.suggest('calendar-helper')).at(0)?.slug).toBe('calendar-helper');
  });
});
