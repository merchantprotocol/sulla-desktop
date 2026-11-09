// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { MarketplaceListingPresenter } from './MarketplaceListingPresenter';

import type { MarketplaceBrowseRow } from '@pkg/typings/electron-ipc';

const base = { id: '1', kind: 'skill', slug: 'one', name: 'One', version: '1', author_user_id: 'u', tags: [], bundle_size: 0, download_count: 0, created_at: '', updated_at: '' } as MarketplaceBrowseRow;
describe('MarketplaceListingPresenter', () => {
  const presenter = new MarketplaceListingPresenter();
  it('formats free and paid prices and leaves missing price blank', () => {
    expect(presenter.present({ ...base, price_cents: 0 }).price).toBe('Free');
    expect(presenter.present({ ...base, price_cents: 1250, currency: 'USD' }).price).toContain('12.50');
    expect(presenter.present({ ...base, price_cents: 1250, currency: 'not-a-currency' }).price).toContain('12.50');
    expect(presenter.present(base).price).toBe('');
  });
  it('chooses video poster, then first photo, then hero image and formats duration', () => {
    expect(presenter.present({ ...base, video_url: 'https://e.test/v', poster_url: 'video.jpg', video_duration_seconds: 305 }).duration).toBe('5:05');
    expect(presenter.present({ ...base, video_url: 'https://e.test/v', poster_url: 'video.jpg' }).image).toBe('video.jpg');
    expect(presenter.present({ ...base, photos: ['first.jpg', 'second.jpg'], poster_url: 'poster.jpg' }).image).toBe('first.jpg');
    expect(presenter.present({ ...base, hero_media: { type: 'image', url: 'hero.jpg' } }).image).toBe('hero.jpg');
  });
});
