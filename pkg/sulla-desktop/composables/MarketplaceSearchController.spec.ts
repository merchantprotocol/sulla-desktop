// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { MarketplaceSearchController } from '../components/routines/MarketplaceSearchController';

import { MarketplaceSearchService, type MarketplaceSearchState } from '@pkg/composables/MarketplaceSearchService';

class FakeRouter {
  currentRoute = { value: { query: { keep: 'yes', q: 'old' } } } as any;
  replace(location: any) { this.currentRoute.value.query = location.query; return Promise.resolve() }
}
const state: MarketplaceSearchState = { q: 'mail', topics: ['Ops'], kinds: ['routine'], media: [], sort: 'popular' };
describe('MarketplaceSearchController', () => {
  it('round-trips route state and preserves unrelated query keys on apply and clear', async() => {
    const router = new FakeRouter();
    const controller = new MarketplaceSearchController(router as any, () => new MarketplaceSearchService([]));
    await controller.apply(state);
    expect(router.currentRoute.value.query).toMatchObject({ keep: 'yes', q: 'mail', topic: 'Ops', type: 'routine', sort: 'popular' });
    const restored = new MarketplaceSearchController(router as any, () => new MarketplaceSearchService([]));
    expect(restored.syncFromRoute()).toEqual(state);
    expect(restored.isResultsMode).toBe(true);
    await controller.clear();
    expect(router.currentRoute.value.query).toEqual({ keep: 'yes' });
    expect(controller.isResultsMode).toBe(false);
  });
});
