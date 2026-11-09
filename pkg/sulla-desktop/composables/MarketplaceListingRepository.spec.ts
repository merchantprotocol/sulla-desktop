// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { MarketplaceListingRepository } from './MarketplaceListingRepository';

describe('MarketplaceListingRepository', () => {
  it('pages through the complete browse catalog instead of stopping at the first page', async() => {
    const calls: number[] = [];
    const repository = new MarketplaceListingRepository({
      browse: async({ page }) => { calls.push(page); return { total: 101, templates: [{ id: String(page), kind: 'skill', slug: `s${ page }`, name: `S${ page }`, author_user_id: 'u', tags: [], version: '1', bundle_size: 0, download_count: 0, created_at: '', updated_at: '' }] }; },
      detail: async() => ({ error: 'unused' }),
    });
    const result = await repository.loadCatalog();
    expect(calls).toEqual([1, 2]);
    expect(result).toHaveLength(2);
  });

  it('omits type facets when any bounded detail fetch fails', async() => {
    const rows = Array.from({ length: 2 }, (_, index) => ({ id: String(index), kind: 'skill', slug: String(index), name: String(index), author_user_id: 'u', tags: [], version: '1', bundle_size: 0, download_count: 0, created_at: '', updated_at: '' } as any));
    const repository = new MarketplaceListingRepository({ browse: async() => ({ total: 0, templates: [] }), detail: async() => ({ error: 'offline' }) });
    expect(await repository.loadKinds(rows)).toEqual(new Map());
  });
});
