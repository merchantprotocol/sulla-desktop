// SPDX-License-Identifier: GPL-2.0-or-later
import type { MarketplaceBrowseRow } from '@pkg/typings/electron-ipc';

export interface MarketplaceSearchState { q: string; topics: string[]; kinds: string[]; media: string[]; sort: 'relevance' | 'popular' | 'newest' | 'name' }
export interface MarketplaceFacet { key: string; label: string; options: { value: string; label: string; count: number }[] }
export interface MarketplaceSearchSummary { total: number; withVideo: number }
export type MarketplaceQuery = Record<string, string | string[] | null | undefined>;

type FilterKey = 'topics' | 'kinds' | 'media';

/** A browse row with everything the filters need precomputed once. */
interface IndexedRow {
  row:         MarketplaceBrowseRow;
  topic:       string;
  kinds:       string[];
  media:       string;
  nameText:    string;
  taglineText: string;
  bodyText:    string;
  haystack:    string;
}

const KIND_LABELS: Record<string, string> = {
  skill:       'Skill',
  routine:     'Workflow',
  function:    'Function',
  agent:       'Agent',
  recipe:      'Recipe',
  integration: 'Integration',
  package:     'Package',
};
const KIND_ORDER = ['skill', 'routine', 'function', 'agent', 'recipe', 'integration', 'package'];
const PHOTO_TYPES = new Set(['image', 'photo', 'photos', 'screenshot', 'screenshots']);
const MEDIA_ORDER = ['video', 'photos'];
const UNCATEGORIZED = 'Uncategorized';

/**
 * Search, facets and URL state over the browse rows already fetched by useMarketplace.
 * One row predicate (`matches`) drives search results and every facet count, so the
 * numbers shown in the filters always agree with the list they produce.
 */
export class MarketplaceSearchService {
  private readonly indexed: IndexedRow[];

  constructor(rows: readonly MarketplaceBrowseRow[], kindsById: ReadonlyMap<string, string[]> = new Map()) {
    this.indexed = rows.map(row => {
      const nameText = [row.name, row.slug].filter(Boolean).join('\n').toLocaleLowerCase();
      const taglineText = (row.tagline ?? '').toLocaleLowerCase();
      const bodyText = [row.description, row.category, ...(row.tags ?? [])].filter(Boolean).join('\n').toLocaleLowerCase();
      return {
        row,
        topic:    row.category || UNCATEGORIZED,
        kinds:    kindsById.get(row.id) ?? [row.kind],
        media:    mediaKey(row.hero_media?.type),
        nameText,
        taglineText,
        bodyText,
        haystack: [nameText, taglineText, bodyText].join('\n'),
      };
    });
  }

  facets(state: MarketplaceSearchState): MarketplaceFacet[] {
    const facets: MarketplaceFacet[] = [];
    // Topic is always shown, even when it has a single option or no rows at all.
    facets.push({ key: 'topics', label: 'Topic', options: this.facetOptions('topics', state, entry => [entry.topic], value => value, undefined) });

    const kinds = this.facetOptions('kinds', state, entry => entry.kinds, kindLabel, KIND_ORDER);
    if (this.showsFacet('kinds', state, kinds)) facets.push({ key: 'kinds', label: 'Type', options: kinds });

    const media = this.facetOptions('media', state, entry => (entry.media ? [entry.media] : []), mediaLabel, MEDIA_ORDER);
    if (this.showsFacet('media', state, media)) facets.push({ key: 'media', label: 'Preview', options: media });
    return facets;
  }

  search(state: MarketplaceSearchState): MarketplaceBrowseRow[] {
    const query = normalizeQuery(state.q);
    const matched = this.indexed.filter(entry => this.matches(entry, state));
    // Array.prototype.sort is stable, so ties keep the catalog order the browse IPC returned.
    matched.sort((a, b) => compareEntries(a, b, state, query));
    return matched.map(entry => entry.row);
  }

  summary(state: MarketplaceSearchState): MarketplaceSearchSummary {
    const matched = this.search(state);
    return { total: matched.length, withVideo: matched.filter(row => mediaKey(row.hero_media?.type) === 'video').length };
  }

  serialize(state: MarketplaceSearchState): URLSearchParams {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(this.toQuery(state))) {
      if (typeof value === 'string') params.set(key, value);
    }
    return params;
  }

  deserialize(params: URLSearchParams): MarketplaceSearchState {
    const record: MarketplaceQuery = {};
    for (const [key, value] of params) {
      const existing = record[key];
      record[key] = existing === undefined ? value : [...(Array.isArray(existing) ? existing : [existing]), value];
    }
    return this.fromQuery(record);
  }

  /** Accepts a vue-router LocationQuery or any plain object of strings / string arrays. */
  fromQuery(query: MarketplaceQuery): MarketplaceSearchState {
    const sort = firstValue(query.sort);
    return {
      q:      firstValue(query.q),
      topics: listValue(query.topic),
      kinds:  listValue(query.type),
      media:  listValue(query.media),
      sort:   sort === 'newest' || sort === 'popular' || sort === 'name' ? sort : 'relevance',
    };
  }

  toQuery(state: MarketplaceSearchState): Record<string, string> {
    const query: Record<string, string> = {};
    if (state.q) query.q = state.q;
    if (state.topics.length) query.topic = state.topics.join(',');
    if (state.kinds.length) query.type = state.kinds.join(',');
    if (state.media.length) query.media = state.media.join(',');
    if (state.sort !== 'relevance') query.sort = state.sort;
    return query;
  }

  /** The one row predicate. Pass `ignoredKey` to count a facet without its own filter applied. */
  private matches(entry: IndexedRow, state: MarketplaceSearchState, ignoredKey?: FilterKey): boolean {
    const query = normalizeQuery(state.q);
    if (query && !entry.haystack.includes(query)) return false;
    if (ignoredKey !== 'topics' && state.topics.length && !state.topics.includes(entry.topic)) return false;
    if (ignoredKey !== 'kinds' && state.kinds.length && !entry.kinds.some(kind => state.kinds.includes(kind))) return false;
    if (ignoredKey !== 'media' && state.media.length && !state.media.includes(entry.media)) return false;
    return true;
  }

  /**
   * Every value that exists in the catalog for this facet, counted over rows that pass
   * the other facets. Zero-count values are dropped unless they are selected, so they can be unticked.
   */
  private facetOptions(
    key: FilterKey,
    state: MarketplaceSearchState,
    valuesOf: (entry: IndexedRow) => string[],
    labelOf: (value: string) => string,
    order: string[] | undefined,
  ): MarketplaceFacet['options'] {
    const selected = new Set(state[key]);
    const universe = new Set<string>(selected);
    for (const entry of this.indexed) for (const value of valuesOf(entry)) universe.add(value);

    const counts = new Map<string, number>();
    for (const entry of this.indexed) {
      if (!this.matches(entry, state, key)) continue;
      for (const value of new Set(valuesOf(entry))) counts.set(value, (counts.get(value) ?? 0) + 1);
    }

    const options = [...universe]
      .filter(value => (counts.get(value) ?? 0) > 0 || selected.has(value))
      .map(value => ({ value, label: labelOf(value), count: counts.get(value) ?? 0 }));
    return sortOptions(options, order);
  }

  /** Type and Preview appear only when at least two values have listings. A selection keeps its group visible so it can be cleared. */
  private showsFacet(key: FilterKey, state: MarketplaceSearchState, options: MarketplaceFacet['options']): boolean {
    return options.filter(option => option.count > 0).length >= 2 || state[key].length > 0;
  }
}

function mediaKey(type: string | null | undefined): string {
  const normalized = (type ?? '').trim().toLocaleLowerCase();
  if (!normalized) return '';
  if (normalized === 'video') return 'video';
  if (PHOTO_TYPES.has(normalized)) return 'photos';
  return normalized;
}

function mediaLabel(value: string): string {
  if (value === 'video') return 'Video walkthrough';
  if (value === 'photos') return 'Photos';
  return capitalize(value);
}

function kindLabel(value: string): string {
  return KIND_LABELS[value] ?? capitalize(value);
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toLocaleUpperCase() + value.slice(1) : value;
}

function sortOptions(options: MarketplaceFacet['options'], order: string[] | undefined): MarketplaceFacet['options'] {
  const rank = (value: string) => {
    const index = order ? order.indexOf(value) : -1;
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return options.sort((a, b) => rank(a.value) - rank(b.value) || a.label.localeCompare(b.label));
}

function normalizeQuery(q: string): string {
  return q.trim().toLocaleLowerCase();
}

/** 0 = name or slug hit, 1 = tagline hit, 2 = description, category or tag hit. */
function relevanceTier(entry: IndexedRow, query: string): number {
  if (entry.nameText.includes(query)) return 0;
  if (entry.taglineText.includes(query)) return 1;
  return 2;
}

function compareEntries(a: IndexedRow, b: IndexedRow, state: MarketplaceSearchState, query: string): number {
  if (state.sort === 'newest') return b.row.created_at.localeCompare(a.row.created_at);
  if (state.sort === 'popular') return b.row.download_count - a.row.download_count;
  if (state.sort === 'name') return a.row.name.localeCompare(b.row.name);
  if (query) return relevanceTier(a, query) - relevanceTier(b, query);
  return Number(b.row.featured ?? false) - Number(a.row.featured ?? false) || b.row.download_count - a.row.download_count;
}

function firstValue(value: string | string[] | null | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

function listValue(value: string | string[] | null | undefined): string[] {
  const parts = (Array.isArray(value) ? value : [value ?? '']).flatMap(part => part.split(','));
  return [...new Set(parts.map(part => part.trim()).filter(Boolean))];
}
