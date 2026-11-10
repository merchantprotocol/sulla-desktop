// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import MarketplaceListingFacts from './MarketplaceListingFacts.vue';
import type { MarketplaceBrowseRow } from '@pkg/typings/electron-ipc';

describe('MarketplaceListingFacts', () => {
  const base = { id: 'listing-1', kind: 'skill', kind_label: 'Skill', slug: 'listing', name: 'Mail triage', version: '1', author_user_id: 'owner', tags: [], bundle_size: 1, download_count: 0, created_at: '', updated_at: '', price_cents: 0, requires_apps: ['Gmail'], topic: 'Operations' } as MarketplaceBrowseRow;

  it('shows only known safety/app data and emits navigable topic/type filters', async() => {
    const wrapper = mount(MarketplaceListingFacts, { props: { row: { ...base, approval_mode: 'drafts_only' } } });
    expect(wrapper.text()).toContain('Works with');
    expect(wrapper.text()).toContain('Gmail');
    expect(wrapper.text()).toContain('It drafts and asks you before acting');
    await wrapper.get('button:nth-of-type(2)').trigger('click');
    expect(wrapper.emitted('filter')?.[0]).toEqual(['topic', 'Operations']);
    await wrapper.get('button:nth-of-type(1)').trigger('click');
    expect(wrapper.emitted('filter')?.[1]).toEqual(['type', 'skill']);
    await wrapper.setProps({ row: { ...base, approval_mode: 'acts' } });
    expect(wrapper.text()).not.toContain("What it won't do on its own");
  });
});
