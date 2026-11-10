// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { MarketplaceSearchController } from '../components/routines/MarketplaceSearchController';

import { MarketplaceSearchService, type MarketplaceSearchState } from '@pkg/composables/MarketplaceSearchService';

class FakeRouter {
  currentRoute = { value: { query: { keep: 'yes', q: 'old' } } } as any;
  replace(location: any) { this.currentRoute.value.query = location.query; return Promise.resolve() }
}
const state: MarketplaceSearchState = { q: 'mail', topics: ['Ops'], kinds: ['routine'], media: [], price: ['free'], length: ['short'], apps: ['Sheets'], approval: ['acts'], sort: 'popular' };
describe('MarketplaceSearchController', () => {
  it('round-trips route state and preserves unrelated query keys on apply and clear', async() => {
    const router = new FakeRouter();
    const controller = new MarketplaceSearchController(router as any, () => new MarketplaceSearchService([]));
    await controller.apply(state);
    expect(router.currentRoute.value.query).toMatchObject({ keep: 'yes', q: 'mail', topic: 'Ops', type: 'routine', price: 'free', length: 'short', app: 'Sheets', approval: 'acts', sort: 'popular' });
    const restored = new MarketplaceSearchController(router as any, () => new MarketplaceSearchService([]));
    expect(restored.syncFromRoute()).toEqual(state);
    expect(restored.isResultsMode).toBe(true);
    await controller.clear();
    expect(router.currentRoute.value.query).toEqual({ keep: 'yes' });
    expect(controller.isResultsMode).toBe(false);
  });

  it('opens and closes a listing without losing search keys, and syncs deep links', async() => {
    const router = new FakeRouter();
    const controller = new MarketplaceSearchController(router as any, () => new MarketplaceSearchService([]));
    await controller.apply(state);
    await controller.openListing('listing-42');
    expect(router.currentRoute.value.query).toMatchObject({ q: 'mail', topic: 'Ops', type: 'routine', listing: 'listing-42' });
    const deepLink = new MarketplaceSearchController(router as any, () => new MarketplaceSearchService([]));
    deepLink.syncFromRoute();
    expect(deepLink.listingId).toBe('listing-42');
    await controller.closeListing();
    expect(router.currentRoute.value.query).not.toHaveProperty('listing');
    expect(router.currentRoute.value.query).toMatchObject({ q: 'mail', topic: 'Ops', type: 'routine' });
  });
});
