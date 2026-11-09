// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import MarketplaceFiltersPopover from './MarketplaceFiltersPopover.vue';

import { MarketplaceSearchService, type MarketplaceSearchState } from '@pkg/composables/MarketplaceSearchService';
import type { MarketplaceBrowseRow } from '@pkg/typings/electron-ipc';

describe('MarketplaceFiltersPopover', () => {
  it('renders real service facet options, live counts and dimmed zero-count options', () => {
    const rows = [
      { id: '1', kind: 'skill', slug: 'one', name: 'One', category: 'Ops', version: '1', author_user_id: 'u', tags: [], bundle_size: 0, download_count: 0, created_at: '', updated_at: '', price_cents: 0 },
      { id: '2', kind: 'routine', slug: 'two', name: 'Two', category: 'Money', version: '1', author_user_id: 'u', tags: [], bundle_size: 0, download_count: 0, created_at: '', updated_at: '', price_cents: 100 },
    ] as MarketplaceBrowseRow[];
    const state: MarketplaceSearchState = { q: '', topics: [], kinds: ['skill'], media: [], price: [], length: [], apps: [], approval: [], sort: 'relevance' };
    const service = new MarketplaceSearchService(rows);
    const wrapper = mount(MarketplaceFiltersPopover, { props: { facets: service.facets(state), state, resultCount: service.search(state).length, open: true } });
    expect(wrapper.text()).toContain('Topic');
    expect(wrapper.text()).toContain('Ops');
    expect(wrapper.text()).toContain('1');
    expect(wrapper.findAll('label.dimmed').length).toBeGreaterThan(0);
    expect(wrapper.text()).toContain('Show 1 use cases');
    wrapper.unmount();
  });
});
