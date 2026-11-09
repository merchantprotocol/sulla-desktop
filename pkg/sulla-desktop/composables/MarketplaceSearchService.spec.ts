// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { MarketplaceSearchService, type MarketplaceSearchState } from './MarketplaceSearchService';

const state: MarketplaceSearchState = { q: '', topics: [], kinds: [], media: [], sort: 'relevance' };
const rows = [
  { id: '1', slug: 'ledger', name: 'Ledgerline', description: 'Close books', category: 'Money', kind: 'skill', tags: ['finance'], created_at: '2026-01-01', download_count: 2 },
  { id: '2', slug: 'inbox', name: 'Sieve', description: 'Sort mail', category: 'Operations', kind: 'routine', tags: [], created_at: '2026-02-01', download_count: 10, hero_media: { type: 'video', url: 'https://example.test/video' } },
] as any;

describe('MarketplaceSearchService', () => {
  it('searches real listing fields and applies filters with AND between facets', () => {
    const service = new MarketplaceSearchService(rows);
    expect(service.search({ ...state, q: 'FINANCE' }).map(row => row.slug)).toEqual(['ledger']);
    expect(service.search({ ...state, topics: ['Money'], kinds: ['routine'] })).toEqual([]);
    expect(service.search({ ...state, topics: ['Operations'], kinds: ['routine'] }).map(row => row.slug)).toEqual(['inbox']);
  });

  it('shows data-backed facet counts and suppresses unsupported facet groups', () => {
    const facets = new MarketplaceSearchService(rows).facets(state);
    expect(facets.map(facet => facet.key)).toEqual(['topics', 'kinds', 'media']);
    expect(facets.find(facet => facet.key === 'topics')?.options).toEqual([
      { value: 'Money', label: 'Money', count: 1 }, { value: 'Operations', label: 'Operations', count: 1 },
    ]);
    expect(new MarketplaceSearchService([{ ...rows[0], hero_media: undefined }]).facets(state).map(facet => facet.key)).toEqual(['topics', 'kinds']);
  });

  it('sorts by popularity and round-trips supported query state', () => {
    const service = new MarketplaceSearchService(rows);
    expect(service.search({ ...state, sort: 'popular' }).map(row => row.slug)).toEqual(['inbox', 'ledger']);
    const serialized = service.serialize({ ...state, q: 'mail', topics: ['Operations'], kinds: ['routine'], media: ['video'], sort: 'newest' });
    expect(service.deserialize(serialized)).toEqual({ q: 'mail', topics: ['Operations'], kinds: ['routine'], media: ['video'], sort: 'newest' });
  });
});
