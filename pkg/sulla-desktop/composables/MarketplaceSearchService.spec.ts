// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { MarketplaceSearchService, type MarketplaceSearchState } from './MarketplaceSearchService';

import type { MarketplaceBrowseRow } from '@pkg/typings/electron-ipc';

const state: MarketplaceSearchState = { q: '', topics: [], kinds: [], media: [], sort: 'relevance' };

/** Real-shaped browse row. Only the fields a test cares about need overriding. */
function row(overrides: Partial<MarketplaceBrowseRow> & Pick<MarketplaceBrowseRow, 'id' | 'slug' | 'name'>): MarketplaceBrowseRow {
  return {
    kind:           'skill',
    tags:           [],
    version:        '1.0.0',
    author_user_id: 'u1',
    bundle_size:    0,
    download_count: 0,
    created_at:     '2026-01-01T00:00:00Z',
    updated_at:     '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// Catalog order matters for the stable-sort assertions below.
const ledger = row({ id: 'a', slug: 'ledger', name: 'Ledgerline', tagline: 'Close the books faster', description: 'Reconcile accounts', category: 'Money', kind: 'skill', tags: ['finance'], featured: true, download_count: 2, created_at: '2026-01-01T00:00:00Z', hero_media: { type: 'video', url: 'https://example.test/a.mp4' } });
const inbox = row({ id: 'b', slug: 'inbox', name: 'Sieve', tagline: 'Sort your mail', description: 'Routes ledger questions to the right desk', category: 'Operations', kind: 'routine', download_count: 10, created_at: '2026-02-01T00:00:00Z', hero_media: { type: 'video', url: 'https://example.test/b.mp4' } });
const payroll = row({ id: 'c', slug: 'pay-run', name: 'Payroll Sync', tagline: 'Automate payroll', description: 'Calls the ledger API nightly', category: 'Money', kind: 'function', tags: ['payroll'], download_count: 5, created_at: '2026-03-01T00:00:00Z', hero_media: { type: 'image', url: 'https://example.test/c.png' } });
const bot = row({ id: 'd', slug: 'ledger-bot', name: 'Books Bot', tagline: 'Answers questions', description: 'Helps with the desk', category: 'Operations', kind: 'agent', tags: ['ledger'], featured: false, download_count: 1, created_at: '2025-12-01T00:00:00Z', hero_media: { type: 'photo', url: 'https://example.test/d.png' } });
const catalog = [ledger, inbox, payroll, bot];

describe('MarketplaceSearchService', () => {
  it('matches the query against name, slug, tagline, description, category and tags, case-insensitively', () => {
    const service = new MarketplaceSearchService(catalog);
    // risk: data accuracy — each searchable field must be able to surface its listing
    expect(service.search({ ...state, q: 'FINANCE' }).map(r => r.slug)).toEqual(['ledger']); // tag
    expect(service.search({ ...state, q: 'faster' }).map(r => r.slug)).toEqual(['ledger']); // tagline
    expect(service.search({ ...state, q: 'nightly' }).map(r => r.slug)).toEqual(['pay-run']); // description
    expect(service.search({ ...state, q: 'operations' }).map(r => r.slug)).toEqual(['inbox', 'ledger-bot']); // category
    expect(service.search({ ...state, q: 'SIEVE' }).map(r => r.slug)).toEqual(['inbox']); // name
    expect(service.search({ ...state, q: 'pay-run' }).map(r => r.slug)).toEqual(['pay-run']); // slug
    expect(service.search({ ...state, q: '  ' })).toHaveLength(4);
  });

  it('ANDs the facet groups and ORs values inside one group', () => {
    const service = new MarketplaceSearchService(catalog);
    // risk: data accuracy — a wrong AND/OR combination shows the wrong listings
    expect(service.search({ ...state, topics: ['Money'], kinds: ['routine'] })).toEqual([]);
    expect(service.search({ ...state, topics: ['Operations'], kinds: ['routine'] }).map(r => r.slug)).toEqual(['inbox']);
    expect(service.search({ ...state, topics: ['Money', 'Operations'] }).map(r => r.slug)).toEqual(['ledger', 'inbox', 'pay-run', 'ledger-bot']);
    expect(service.search({ ...state, kinds: ['skill', 'agent'] }).map(r => r.slug)).toEqual(['ledger', 'ledger-bot']);
    expect(service.search({ ...state, media: ['video'] }).map(r => r.slug)).toEqual(['ledger', 'inbox']);
    expect(service.search({ ...state, media: ['video', 'photos'] })).toHaveLength(4);
  });

  it('counts each facet without its own filter but with every other filter applied', () => {
    const service = new MarketplaceSearchService(catalog);
    // risk: data accuracy — a facet that counts its own group would hide options the user could pick
    const topicOptions = (s: MarketplaceSearchState) => service.facets(s).find(f => f.key === 'topics')!.options;
    expect(topicOptions({ ...state, topics: ['Money'] })).toEqual([
      { value: 'Money', label: 'Money', count: 2 }, { value: 'Operations', label: 'Operations', count: 2 },
    ]);
    // Only Payroll Sync is a function, so Operations drops out entirely (zero count, not selected).
    expect(topicOptions({ ...state, topics: ['Money'], kinds: ['function'] })).toEqual([
      { value: 'Money', label: 'Money', count: 1 },
    ]);
  });

  it('keeps zero-count options that are selected so they can be unticked', () => {
    const service = new MarketplaceSearchService(catalog);
    // risk: data accuracy — a selected filter must stay visible even when the current search gives it no results
    const topic = service.facets({ ...state, q: 'bot', topics: ['Money'] }).find(f => f.key === 'topics')!;
    expect(topic.options).toEqual([
      { value: 'Money', label: 'Money', count: 0 }, { value: 'Operations', label: 'Operations', count: 1 },
    ]);
    const ghost = service.facets({ ...state, topics: ['Ghost'] }).find(f => f.key === 'topics')!;
    expect(ghost.options).toContainEqual({ value: 'Ghost', label: 'Ghost', count: 0 });
  });

  it('applies the Type filter through kindsById and counts Type from the same lookup', () => {
    // Pay-run is a function on its row, but its package contents also include a skill and a workflow.
    const kindsById = new Map([['c', ['skill', 'routine']]]);
    const service = new MarketplaceSearchService(catalog, kindsById);
    // risk: data accuracy — the Type filter must use contents kinds, not only row.kind
    expect(service.search({ ...state, kinds: ['routine'] }).map(r => r.slug)).toEqual(['inbox', 'pay-run']);
    expect(service.search({ ...state, kinds: ['function'] })).toEqual([]);
    const facets = service.facets({ ...state, kinds: ['routine'] });
    expect(facets.find(f => f.key === 'kinds')!.options).toEqual([
      { value: 'skill', label: 'Skill', count: 2 },
      { value: 'routine', label: 'Workflow', count: 2 },
      { value: 'agent', label: 'Agent', count: 1 },
    ]);
    // The Topic facet, with Type applied, must count Payroll Sync under Money through its contents.
    expect(service.facets({ ...state, kinds: ['routine'] }).find(f => f.key === 'topics')!.options).toEqual([
      { value: 'Money', label: 'Money', count: 1 }, { value: 'Operations', label: 'Operations', count: 1 },
    ]);
  });

  it('ranks name and slug hits above tagline above description and tags, keeping catalog order within a tier', () => {
    const descriptionHit = row({ id: 'r1', slug: 'r1', name: 'Alpha', description: 'Tracks payroll items' });
    const tagHit = row({ id: 'r2', slug: 'r2', name: 'Beta', tags: ['payroll'] });
    const taglineHit = row({ id: 'r3', slug: 'r3', name: 'Gamma', tagline: 'Payroll in one click' });
    const nameHit = row({ id: 'r4', slug: 'r4', name: 'Payroll Sync' });
    const service = new MarketplaceSearchService([descriptionHit, tagHit, taglineHit, nameHit]);
    expect(service.search({ ...state, q: 'payroll' }).map(r => r.slug)).toEqual(['r4', 'r3', 'r1', 'r2']);
  });

  it('keeps featured first and then downloads when relevance has no query', () => {
    const service = new MarketplaceSearchService(catalog);
    expect(service.search(state).map(r => r.slug)).toEqual(['ledger', 'inbox', 'pay-run', 'ledger-bot']);
  });

  it('sorts by name, newest and popular', () => {
    const service = new MarketplaceSearchService(catalog);
    expect(service.search({ ...state, sort: 'name' }).map(r => r.name)).toEqual(['Books Bot', 'Ledgerline', 'Payroll Sync', 'Sieve']);
    expect(service.search({ ...state, sort: 'newest' }).map(r => r.slug)).toEqual(['pay-run', 'inbox', 'ledger', 'ledger-bot']);
    expect(service.search({ ...state, sort: 'popular' }).map(r => r.slug)).toEqual(['inbox', 'pay-run', 'ledger', 'ledger-bot']);
  });

  it('shows Type and Preview only when two or more values have listings, and always shows Topic', () => {
    const singleKind = new MarketplaceSearchService([ledger, bot].map(r => ({ ...r, kind: 'skill' as const, hero_media: { type: 'video', url: 'u' } })));
    expect(singleKind.facets(state).map(f => f.key)).toEqual(['topics']);
    const single = new MarketplaceSearchService([ledger]);
    expect(single.facets(state).map(f => f.key)).toEqual(['topics']);
    expect(single.facets(state)[0].options).toEqual([{ value: 'Money', label: 'Money', count: 1 }]);
    expect(new MarketplaceSearchService([]).facets(state)).toEqual([{ key: 'topics', label: 'Topic', options: [] }]);
    expect(new MarketplaceSearchService(catalog).facets(state).map(f => f.key)).toEqual(['topics', 'kinds', 'media']);
  });

  it('keeps Type and Preview visible while one of them is selected, so the selection can be cleared', () => {
    const service = new MarketplaceSearchService([ledger]);
    expect(service.facets({ ...state, media: ['video'] }).map(f => f.key)).toEqual(['topics', 'media']);
  });

  it('labels Type and Preview options with human names', () => {
    const service = new MarketplaceSearchService(catalog);
    const facets = service.facets(state);
    expect(facets.find(f => f.key === 'media')!.options).toEqual([
      { value: 'video', label: 'Video walkthrough', count: 2 },
      { value: 'photos', label: 'Photos', count: 2 },
    ]);
    expect(facets.find(f => f.key === 'kinds')!.options.map(o => o.label)).toEqual(['Skill', 'Workflow', 'Function', 'Agent']);
  });

  it('summarises the filtered results as total and listings with video', () => {
    const service = new MarketplaceSearchService(catalog);
    // risk: data accuracy — the results count must match the list it describes
    expect(service.summary(state)).toEqual({ total: 4, withVideo: 2 });
    expect(service.summary({ ...state, kinds: ['skill'] })).toEqual({ total: 1, withVideo: 1 });
    expect(service.summary({ ...state, q: 'nomatch' })).toEqual({ total: 0, withVideo: 0 });
  });

  it('round-trips state through URLSearchParams', () => {
    const service = new MarketplaceSearchService(catalog);
    const original: MarketplaceSearchState = { q: 'mail', topics: ['Operations'], kinds: ['routine'], media: ['video'], sort: 'newest' };
    const serialized = service.serialize(original);
    expect(serialized.get('topic')).toBe('Operations');
    expect(service.deserialize(serialized)).toEqual(original);
    expect(service.serialize(state).toString()).toBe('');
  });

  it('round-trips state through a plain object query (vue-router LocationQuery shape)', () => {
    const service = new MarketplaceSearchService(catalog);
    const fromRouter = service.fromQuery({ q: 'mail', topic: ['Money', 'Operations'], type: 'skill,routine', media: null, sort: 'name' });
    expect(fromRouter).toEqual({ q: 'mail', topics: ['Money', 'Operations'], kinds: ['skill', 'routine'], media: [], sort: 'name' });
    expect(service.fromQuery(service.toQuery(fromRouter))).toEqual(fromRouter);
  });

  it('reads repeated URL params and falls back to relevance for unknown sorts', () => {
    const service = new MarketplaceSearchService(catalog);
    const params = new URLSearchParams('topic=Money&topic=Operations&sort=sideways');
    expect(service.deserialize(params)).toEqual({ q: '', topics: ['Money', 'Operations'], kinds: [], media: [], sort: 'relevance' });
  });

  it('returns at least one facet group for real-shaped rows with missing optional fields', () => {
    const sparse = [
      row({ id: 'x1', slug: 'x1', name: 'Plain', kind: 'package', category: null, tagline: null, description: null, hero_media: null }),
      row({ id: 'x2', slug: 'x2', name: 'Other', kind: 'package', category: '', tagline: null, description: null, hero_media: undefined }),
    ];
    const facets = new MarketplaceSearchService(sparse).facets(state);
    // risk: data accuracy — the filter panel must never render empty for a real catalog
    expect(facets.length).toBeGreaterThanOrEqual(1);
    expect(facets[0]).toEqual({ key: 'topics', label: 'Topic', options: [{ value: 'Uncategorized', label: 'Uncategorized', count: 2 }] });
  });
});
