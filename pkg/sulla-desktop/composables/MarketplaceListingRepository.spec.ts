// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { MarketplaceListingRepository } from './MarketplaceListingRepository';

describe('MarketplaceListingRepository', () => {
  it('pages through the complete browse catalog instead of stopping at the first page', async() => {
    const calls: number[] = [];
    const repository = new MarketplaceListingRepository({
      browse: ({ page }) => {
        calls.push(page);
        return Promise.resolve({ total: 101, templates: [{ id: String(page), kind: 'skill', slug: `s${ page }`, name: `S${ page }`, author_user_id: 'u', tags: [], version: '1', bundle_size: 0, download_count: 0, created_at: '', updated_at: '' }] });
      },
      detail: () => Promise.resolve({ error: 'unused' }),
    });
    const result = await repository.loadCatalog();
    expect(calls).toEqual([1, 2]);
    expect(result).toHaveLength(2);
  });

  it('omits type facets when any bounded detail fetch fails', async() => {
    const rows = Array.from({ length: 2 }, (_, index) => ({ id: String(index), kind: 'skill', slug: String(index), name: String(index), author_user_id: 'u', tags: [], version: '1', bundle_size: 0, download_count: 0, created_at: '', updated_at: '' } as any));
    const repository = new MarketplaceListingRepository({ browse: () => Promise.resolve({ total: 0, templates: [] }), detail: () => Promise.resolve({ error: 'offline' }) });
    expect(await repository.loadKinds(rows)).toEqual(new Map());
  });

  it('reads contents kinds from each bounded detail and dedupes them', async() => {
    // risk: data accuracy — the Type facet for packages depends on these kinds
    const rows = [{ id: 'p1', kind: 'package' }, { id: 'p2', kind: 'package' }] as any[];
    const repository = new MarketplaceListingRepository({
      browse: () => Promise.resolve({ total: 0, templates: [] }),
      detail: id => Promise.resolve({ template: { id, manifest: { contents: id === 'p1' ? [{ kind: 'skill' }, { kind: 'routine' }, { kind: 'skill' }] : [{ kind: 'agent' }, 'junk'] } } as any }),
    });
    expect(await repository.loadKinds(rows)).toEqual(new Map([['p1', ['skill', 'routine']], ['p2', ['agent']]]));
  });

  it('skips detail calls entirely above the cap, so large catalogs cost no N+1 requests', async() => {
    // risk: money — a runaway fan-out of detail calls on every catalog load
    const rows = Array.from({ length: MarketplaceListingRepository.DETAIL_CAP + 1 }, (_, index) => ({ id: String(index), kind: 'package' }) as any);
    let detailCalls = 0;
    const repository = new MarketplaceListingRepository({
      browse: () => Promise.resolve({ total: 0, templates: [] }),
      detail: () => { detailCalls += 1; return Promise.resolve({ error: 'unused' }) },
    });
    expect(await repository.loadKinds(rows)).toEqual(new Map());
    expect(detailCalls).toBe(0);
  });
});
