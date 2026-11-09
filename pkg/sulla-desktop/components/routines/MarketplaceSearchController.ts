// SPDX-License-Identifier: GPL-2.0-or-later
import type { MarketplaceSearchState } from '@pkg/composables/MarketplaceSearchService';

import type { Router, LocationQuery } from 'vue-router';

export class MarketplaceSearchController {
  state: MarketplaceSearchState = { q: '', topics: [], kinds: [], media: [], price: [], length: [], apps: [], approval: [], sort: 'relevance' };
  isResultsMode = false;
  constructor(private readonly router: Pick<Router, 'currentRoute' | 'replace'>, private readonly createService: () => { serialize(state: MarketplaceSearchState): URLSearchParams; deserialize(params: URLSearchParams): MarketplaceSearchState; queryKeys(): readonly string[] }) {}
  syncFromRoute(query: LocationQuery = this.router.currentRoute.value.query): MarketplaceSearchState {
    const params = new URLSearchParams();
    for (const key of this.createService().queryKeys()) { const value = query[key]; if (typeof value === 'string') params.set(key, value); }
    this.state = this.createService().deserialize(params);
    this.isResultsMode = !!(this.state.q || this.state.topics.length || this.state.kinds.length || this.state.media.length || this.state.price.length || this.state.length.length || this.state.apps.length || this.state.approval.length);
    return this.state;
  }

  async apply(state: MarketplaceSearchState): Promise<void> {
    this.state = { ...state, topics: [...state.topics], kinds: [...state.kinds], media: [...state.media], price: [...state.price], length: [...state.length], apps: [...state.apps], approval: [...state.approval] };
    this.isResultsMode = true;
    await this.writeQuery();
  }

  async clear(): Promise<void> {
    this.state = { q: '', topics: [], kinds: [], media: [], price: [], length: [], apps: [], approval: [], sort: 'relevance' };
    this.isResultsMode = false;
    await this.writeQuery();
  }

  private async writeQuery(): Promise<void> {
    const existing = this.router.currentRoute.value.query;
    const preserved: Record<string, unknown> = { ...existing };
    for (const key of this.createService().queryKeys()) delete preserved[key];
    const params = this.createService().serialize(this.state);
    for (const [key, value] of params) preserved[key] = value;
    await this.router.replace({ query: preserved as LocationQuery });
  }
}
