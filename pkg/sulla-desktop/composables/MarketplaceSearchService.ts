// SPDX-License-Identifier: GPL-2.0-or-later
import type { MarketplaceBrowseRow } from '@pkg/typings/electron-ipc';

export interface MarketplaceSearchState { q: string; topics: string[]; kinds: string[]; media: string[]; price: string[]; length: string[]; apps: string[]; approval: string[]; sort: 'relevance' | 'popular' | 'newest' | 'name' }
export interface MarketplaceFacet { key: string; label: string; options: { value: string; label: string; count: number }[] }
export interface MarketplaceSearchSummary { total: number; withVideo: number }
/** One query-string value as vue-router's LocationQuery and URLSearchParams produce it: a string, a missing value, or a list. */
export type MarketplaceQueryValue = string | null | undefined | (string | null)[];
export type MarketplaceQuery = Record<string, MarketplaceQueryValue>;

type FilterKey = 'topics' | 'kinds' | 'media' | 'price' | 'length' | 'apps' | 'approval';
type FacetOption = MarketplaceFacet['options'][number];

/** A browse row with everything the filters need precomputed once. */
interface IndexedRow {
  row:         MarketplaceBrowseRow;
  topic:       string;
  kinds:       string[];
  media:       string;
  priceKey:    string;
  lengthKey:   string;
  nameText:    string;
  taglineText: string;
  bodyText:    string;
  haystack:    string;
}

/**
 * Labels, media normalization and option ordering for the marketplace filters.
 * Every table lives here as a class member, so no module-level state exists.
 * Injected into MarketplaceSearchService so tests and callers can swap the vocabulary.
 */
export class MarketplaceFacetVocabulary {
  private static readonly KIND_LABELS: Readonly<Record<string, string>> = {
    skill:       'Skill',
    routine:     'Workflow',
    function:    'Function',
    agent:       'Agent',
    recipe:      'Recipe',
    integration: 'Integration',
    package:     'Package',
  };

  private static readonly KIND_ORDER:      readonly string[] = ['skill', 'routine', 'function', 'agent', 'recipe', 'integration', 'package'];
  private static readonly MEDIA_ORDER:     readonly string[] = ['video', 'photos'];
  private static readonly PRICE_ORDER:     readonly string[] = ['free', 'paid'];
  private static readonly LENGTH_ORDER:    readonly string[] = ['short', 'medium', 'long'];
  private static readonly PHOTO_TYPES:     ReadonlySet<string> = new Set(['image', 'photo', 'photos', 'screenshot', 'screenshots']);
  private static readonly PRICE_LABELS:    Readonly<Record<string, string>> = { free: 'Free', paid: 'Paid' };
  private static readonly LENGTH_LABELS:   Readonly<Record<string, string>> = { short: 'Under 5 min', medium: '5–20 min', long: 'Over 20 min' };
  private static readonly APPROVAL_LABELS: Readonly<Record<string, string>> = { drafts_only: 'Drafts only (asks before acting)' };
  private static readonly UNCATEGORIZED = 'Uncategorized';
  /** Video length cut-offs in seconds: under SHORT_MAX is short, up to MEDIUM_MAX is medium, else long. */
  private static readonly SHORT_MAX_SECONDS = 300;
  private static readonly MEDIUM_MAX_SECONDS = 1200;

  constructor(
    private readonly kindLabels: Readonly<Record<string, string>> = MarketplaceFacetVocabulary.KIND_LABELS,
    private readonly kindOrder: readonly string[] = MarketplaceFacetVocabulary.KIND_ORDER,
    private readonly mediaOrder: readonly string[] = MarketplaceFacetVocabulary.MEDIA_ORDER,
    private readonly photoTypes: ReadonlySet<string> = MarketplaceFacetVocabulary.PHOTO_TYPES,
  ) {}

  get uncategorizedLabel(): string {
    return MarketplaceFacetVocabulary.UNCATEGORIZED;
  }

  /** `free` for zero-price rows, `paid` for positive prices, '' when the price is unknown. */
  priceKey(row: MarketplaceBrowseRow): string {
    if (row.price_cents === 0) return 'free';
    if (typeof row.price_cents === 'number' && row.price_cents > 0) return 'paid';
    return '';
  }

  priceLabel(value: string): string {
    return MarketplaceFacetVocabulary.PRICE_LABELS[value] ?? this.capitalize(value);
  }

  /** `short`, `medium` or `long` by duration in seconds; '' when the duration is unknown. */
  lengthKey(seconds: number | null | undefined): string {
    if (typeof seconds !== 'number') return '';
    if (seconds < MarketplaceFacetVocabulary.SHORT_MAX_SECONDS) return 'short';
    if (seconds <= MarketplaceFacetVocabulary.MEDIUM_MAX_SECONDS) return 'medium';
    return 'long';
  }

  lengthLabel(value: string): string {
    return MarketplaceFacetVocabulary.LENGTH_LABELS[value] ?? value;
  }

  approvalLabel(value: string): string {
    return MarketplaceFacetVocabulary.APPROVAL_LABELS[value] ?? 'Acts on its own';
  }

  /** Collapses hero media types to one filter value: `video`, `photos`, or the lowercased type. */
  mediaKey(type: string | null | undefined): string {
    const normalized = (type ?? '').trim().toLocaleLowerCase();
    if (!normalized) return '';
    if (normalized === 'video') return 'video';
    if (this.photoTypes.has(normalized)) return 'photos';
    return normalized;
  }

  mediaLabel(value: string): string {
    if (value === 'video') return 'Video walkthrough';
    if (value === 'photos') return 'Photos';
    return this.capitalize(value);
  }

  kindLabel(value: string): string {
    return this.kindLabels[value] ?? this.capitalize(value);
  }

  /** Known values follow the vocabulary order; unknown values sort last by label. */
  sortOptions(options: FacetOption[], kind: 'kinds' | 'media' | 'topics' | 'price' | 'length'): FacetOption[] {
    const order = kind === 'kinds' ? this.kindOrder : kind === 'media' ? this.mediaOrder : kind === 'price' ? MarketplaceFacetVocabulary.PRICE_ORDER : kind === 'length' ? MarketplaceFacetVocabulary.LENGTH_ORDER : undefined;
    const rank = (value: string) => {
      const index = order ? order.indexOf(value) : -1;
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };
    return [...options].sort((a, b) => rank(a.value) - rank(b.value) || a.label.localeCompare(b.label));
  }

  private capitalize(value: string): string {
    return value ? value.charAt(0).toLocaleUpperCase() + value.slice(1) : value;
  }
}

/**
 * Search, facets and URL state over the browse rows already fetched by useMarketplace.
 * One row predicate (`matches`) drives search results and every facet count, so the
 * numbers shown in the filters always agree with the list they produce.
 */
export class MarketplaceSearchService {
  private readonly indexed: IndexedRow[];

  constructor(
    rows: readonly MarketplaceBrowseRow[],
    kindsById: ReadonlyMap<string, string[]> = new Map(),
    private readonly vocabulary: MarketplaceFacetVocabulary = new MarketplaceFacetVocabulary(),
  ) {
    this.indexed = rows.map(row => {
      const nameText = [row.name, row.slug].filter(Boolean).join('\n').toLocaleLowerCase();
      const taglineText = (row.tagline ?? '').toLocaleLowerCase();
      const bodyText = [row.description, row.category, ...(row.tags ?? [])].filter(Boolean).join('\n').toLocaleLowerCase();
      return {
        row,
        topic:     row.topic || row.category || this.vocabulary.uncategorizedLabel,
        kinds:     row.kind && row.kind !== 'package' ? [row.kind] : kindsById.get(row.id) ?? [row.kind],
        media:     row.video_url ? 'video' : (row.photos?.length ? 'photos' : this.vocabulary.mediaKey(row.hero_media?.type)),
        priceKey:  this.vocabulary.priceKey(row),
        lengthKey: this.vocabulary.lengthKey(row.video_duration_seconds),
        nameText,
        taglineText,
        bodyText,
        haystack:  [nameText, taglineText, bodyText].join('\n'),
      };
    });
  }

  facets(state: MarketplaceSearchState): MarketplaceFacet[] {
    const facets: MarketplaceFacet[] = [];
    // Topic is always shown, even when it has a single option or no rows at all.
    facets.push({ key: 'topics', label: 'Topic', options: this.facetOptions('topics', state, entry => [entry.topic], value => value) });

    const kinds = this.facetOptions('kinds', state, entry => entry.kinds, value => this.vocabulary.kindLabel(value));
    if (this.showsFacet('kinds', state, kinds)) facets.push({ key: 'kinds', label: 'Type', options: kinds });

    const media = this.facetOptions('media', state, entry => (entry.media ? [entry.media] : []), value => this.vocabulary.mediaLabel(value));
    if (this.showsFacet('media', state, media)) facets.push({ key: 'media', label: 'Preview', options: media });
    const price = this.facetOptions('price', state, entry => entry.priceKey ? [entry.priceKey] : [], value => this.vocabulary.priceLabel(value));
    if (this.showsFacet('price', state, price)) facets.push({ key: 'price', label: 'Price', options: price });
    const length = this.facetOptions('length', state, entry => entry.lengthKey ? [entry.lengthKey] : [], value => this.vocabulary.lengthLabel(value));
    if (this.showsFacet('length', state, length)) facets.push({ key: 'length', label: 'Video length', options: length });
    const apps = this.facetOptions('apps', state, entry => entry.row.requires_apps ?? [], value => value);
    if (this.showsFacet('apps', state, apps)) facets.push({ key: 'apps', label: 'Works with', options: apps });
    const approval = this.facetOptions('approval', state, entry => entry.row.approval_mode ? [entry.row.approval_mode] : [], value => this.vocabulary.approvalLabel(value));
    if (this.showsFacet('approval', state, approval)) facets.push({ key: 'approval', label: 'Approval', options: approval });
    return facets;
  }

  search(state: MarketplaceSearchState): MarketplaceBrowseRow[] {
    const query = this.normalizeQuery(state.q);
    const matched = this.indexed.filter(entry => this.matches(entry, state));
    // Array.prototype.sort is stable, so ties keep the catalog order the browse IPC returned.
    matched.sort((a, b) => this.compareEntries(a, b, state, query));
    return matched.map(entry => entry.row);
  }

  summary(state: MarketplaceSearchState): MarketplaceSearchSummary {
    const matched = this.search(state);
    return { total: matched.length, withVideo: matched.filter(row => Boolean(row.video_url) || this.vocabulary.mediaKey(row.hero_media?.type) === 'video').length };
  }

  serialize(state: MarketplaceSearchState): URLSearchParams {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(this.toQuery(state))) {
      if (typeof value === 'string') params.set(key, value);
    }
    return params;
  }

  deserialize(params: URLSearchParams): MarketplaceSearchState {
    const record: Record<string, string[]> = {};
    for (const [key, value] of params) {
      const values = record[key] ?? [];
      values.push(value);
      record[key] = values;
    }
    return this.fromQuery(record);
  }

  /** Accepts a vue-router LocationQuery or any plain object of strings / string arrays. */
  fromQuery(query: MarketplaceQuery): MarketplaceSearchState {
    const sort = this.firstValue(query.sort);
    return {
      q:        this.firstValue(query.q),
      topics:   this.listValue(query.topic),
      kinds:    this.listValue(query.type),
      media:    this.listValue(query.media),
      price:    this.listValue(query.price),
      length:   this.listValue(query.length),
      apps:     this.listValue(query.app),
      approval: this.listValue(query.approval),
      sort:     sort === 'newest' || sort === 'popular' || sort === 'name' ? sort : 'relevance',
    };
  }

  toQuery(state: MarketplaceSearchState): Record<string, string> {
    const query: Record<string, string> = {};
    if (state.q) query.q = state.q;
    if (state.topics.length) query.topic = state.topics.join(',');
    if (state.kinds.length) query.type = state.kinds.join(',');
    if (state.media.length) query.media = state.media.join(',');
    if (state.price.length) query.price = state.price.join(',');
    if (state.length.length) query.length = state.length.join(',');
    if (state.apps.length) query.app = state.apps.join(',');
    if (state.approval.length) query.approval = state.approval.join(',');
    if (state.sort !== 'relevance') query.sort = state.sort;
    return query;
  }

  queryKeys(): readonly string[] { return ['q', 'topic', 'type', 'media', 'price', 'length', 'app', 'approval', 'sort'] }

  /** The one row predicate. Pass `ignoredKey` to count a facet without its own filter applied. */
  private matches(entry: IndexedRow, state: MarketplaceSearchState, ignoredKey?: FilterKey): boolean {
    const query = this.normalizeQuery(state.q);
    if (query && !entry.haystack.includes(query)) return false;
    if (ignoredKey !== 'topics' && state.topics.length && !state.topics.includes(entry.topic)) return false;
    if (ignoredKey !== 'kinds' && state.kinds.length && !entry.kinds.some(kind => state.kinds.includes(kind))) return false;
    if (ignoredKey !== 'media' && state.media.length && !state.media.includes(entry.media)) return false;
    if (ignoredKey !== 'price' && state.price.length && !state.price.includes(entry.priceKey)) return false;
    if (ignoredKey !== 'length' && state.length.length && !state.length.includes(entry.lengthKey)) return false;
    if (ignoredKey !== 'apps' && state.apps.length && !state.apps.some(app => (entry.row.requires_apps ?? []).includes(app))) return false;
    if (ignoredKey !== 'approval' && state.approval.length && !state.approval.includes(entry.row.approval_mode ?? '')) return false;
    return true;
  }

  /**
   * Every value that exists in the catalog for this facet, counted over rows that pass
   * the other facets. Zero-count values stay in the list so the UI can dim them.
   */
  private facetOptions(
    key: FilterKey,
    state: MarketplaceSearchState,
    valuesOf: (entry: IndexedRow) => string[],
    labelOf: (value: string) => string,
  ): FacetOption[] {
    const universe = new Set<string>(state[key]);
    for (const entry of this.indexed) for (const value of valuesOf(entry)) universe.add(value);

    const counts = new Map<string, number>();
    for (const entry of this.indexed) {
      if (!this.matches(entry, state, key)) continue;
      for (const value of new Set(valuesOf(entry))) counts.set(value, (counts.get(value) ?? 0) + 1);
    }

    const options = [...universe].map(value => ({ value, label: labelOf(value), count: counts.get(value) ?? 0 }));
    return this.vocabulary.sortOptions(options, key === 'apps' || key === 'approval' ? 'topics' : key);
  }

  /** Type and Preview appear only when at least two values have listings. A selection keeps its group visible so it can be cleared. */
  private showsFacet(key: FilterKey, state: MarketplaceSearchState, options: FacetOption[]): boolean {
    return options.filter(option => option.count > 0).length >= 2 || state[key].length > 0;
  }

  private normalizeQuery(q: string): string {
    return q.trim().toLocaleLowerCase();
  }

  /** 0 = name or slug hit, 1 = tagline hit, 2 = description, category or tag hit. */
  private relevanceTier(entry: IndexedRow, query: string): number {
    if (entry.nameText.includes(query)) return 0;
    if (entry.taglineText.includes(query)) return 1;
    return 2;
  }

  private compareEntries(a: IndexedRow, b: IndexedRow, state: MarketplaceSearchState, query: string): number {
    if (state.sort === 'newest') return b.row.created_at.localeCompare(a.row.created_at);
    if (state.sort === 'popular') return b.row.download_count - a.row.download_count;
    if (state.sort === 'name') return a.row.name.localeCompare(b.row.name);
    if (query) return this.relevanceTier(a, query) - this.relevanceTier(b, query);
    return Number(b.row.featured ?? false) - Number(a.row.featured ?? false) || b.row.download_count - a.row.download_count;
  }

  private firstValue(value: MarketplaceQueryValue): string {
    return (Array.isArray(value) ? value[0] : value) ?? '';
  }

  private listValue(value: MarketplaceQueryValue): string[] {
    const raw = Array.isArray(value) ? value : [value];
    const parts = raw.filter((part): part is string => typeof part === 'string').flatMap(part => part.split(','));
    return [...new Set(parts.map(part => part.trim()).filter(Boolean))];
  }
}
