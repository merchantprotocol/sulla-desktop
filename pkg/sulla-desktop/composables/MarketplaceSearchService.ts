// SPDX-License-Identifier: GPL-2.0-or-later
import type { MarketplaceBrowseRow } from '@pkg/typings/electron-ipc';

export type MarketplaceSearchState = { q: string; topics: string[]; kinds: string[]; media: string[]; sort: 'relevance' | 'popular' | 'newest' };
export type MarketplaceFacet = { key: string; label: string; options: Array<{ value: string; label: string; count: number }> };

/** Search and facets over the real browse rows already fetched by useMarketplace. */
export class MarketplaceSearchService {
  constructor(private readonly rows: readonly MarketplaceBrowseRow[]) {}

  facets(state: MarketplaceSearchState): MarketplaceFacet[] {
    const facets: MarketplaceFacet[] = [];
    const topics = this.counts(row => row.category || 'Uncategorized', state, 'topics');
    if (topics.length) facets.push({ key: 'topics', label: 'Topic', options: topics });
    const kinds = this.counts(row => row.kind, state, 'kinds');
    if (kinds.length) facets.push({ key: 'kinds', label: 'Type', options: kinds });
    const media = this.counts(row => row.hero_media?.type, state, 'media', true);
    if (media.length) facets.push({ key: 'media', label: 'Preview', options: media });
    return facets;
  }

  search(state: MarketplaceSearchState): MarketplaceBrowseRow[] {
    const query = state.q.trim().toLocaleLowerCase();
    const result = this.rows.filter(row => {
      const matchesQuery = !query || [row.name, row.slug, row.description, row.tagline, row.category, ...(row.tags ?? [])]
        .some(value => value?.toLocaleLowerCase().includes(query));
      const topic = row.category || 'Uncategorized';
      const matches = (values: string[], value: string) => !values.length || values.includes(value);
      return matchesQuery && matches(state.topics, topic) && matches(state.kinds, row.kind) && matches(state.media, row.hero_media?.type ?? '');
    });
    return [...result].sort((a, b) => state.sort === 'newest' ? b.created_at.localeCompare(a.created_at) : state.sort === 'popular' ? b.download_count - a.download_count : 0);
  }

  serialize(state: MarketplaceSearchState): URLSearchParams {
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.topics.length) params.set('topic', state.topics.join(','));
    if (state.kinds.length) params.set('type', state.kinds.join(','));
    if (state.media.length) params.set('media', state.media.join(','));
    if (state.sort !== 'relevance') params.set('sort', state.sort);
    return params;
  }

  deserialize(params: URLSearchParams): MarketplaceSearchState {
    const list = (key: string) => (params.get(key) ?? '').split(',').filter(Boolean);
    const sort = params.get('sort');
    return { q: params.get('q') ?? '', topics: list('topic'), kinds: list('type'), media: list('media'), sort: sort === 'newest' || sort === 'popular' ? sort : 'relevance' };
  }

  private counts(valueFor: (row: MarketplaceBrowseRow) => string | null | undefined, state: MarketplaceSearchState, ignoredKey: keyof MarketplaceSearchState, omitEmpty = false) {
    const rows = this.rows.filter(row => {
      const query = state.q.trim().toLocaleLowerCase();
      const matchesQuery = !query || [row.name, row.slug, row.description, row.tagline, row.category, ...(row.tags ?? [])].some(value => value?.toLocaleLowerCase().includes(query));
      const filters = (['topics', 'kinds', 'media'] as const).filter(key => key !== ignoredKey);
      return matchesQuery && filters.every(key => !state[key].length || state[key].includes(key === 'topics' ? row.category || 'Uncategorized' : key === 'kinds' ? row.kind : row.hero_media?.type ?? ''));
    });
    const counts = new Map<string, number>();
    for (const row of rows) {
      const value = valueFor(row);
      if (value && (!omitEmpty || value)) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts].map(([value, count]) => ({ value, label: value, count })).sort((a, b) => a.label.localeCompare(b.label));
  }
}
