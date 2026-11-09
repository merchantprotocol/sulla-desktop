// SPDX-License-Identifier: GPL-2.0-or-later
import type { MarketplaceBrowseRow } from '@pkg/typings/electron-ipc';

export interface MarketplaceListingPresentation { image: string; video: boolean; duration: string; price: string; topic: string; apps: string[]; draftsOnly: boolean }

/** Formats listing fields once for all marketplace result surfaces. */
export class MarketplaceListingPresenter {
  present(row: MarketplaceBrowseRow): MarketplaceListingPresentation {
    const video = Boolean(row.video_url || row.hero_media?.type === 'video');
    const image = video
      ? row.poster_url || row.hero_media?.poster || ''
      : row.photos?.[0] || row.poster_url || row.hero_media?.poster || row.hero_media?.url || '';
    return {
      image,
      video,
      duration:   typeof row.video_duration_seconds === 'number' ? this.duration(row.video_duration_seconds) : '',
      price:      this.price(row),
      topic:      row.topic || row.category || 'Uncategorized',
      apps:       row.requires_apps ?? [],
      draftsOnly: row.approval_mode === 'drafts_only',
    };
  }

  private duration(seconds: number): string {
    const total = Math.floor(seconds);
    return `${ Math.floor(total / 60) }:${ String(total % 60).padStart(2, '0') }`;
  }

  private price(row: MarketplaceBrowseRow): string {
    if (row.price_cents === 0) return 'Free';
    if (typeof row.price_cents !== 'number' || row.price_cents < 0) return '';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: row.currency || 'USD' }).format(row.price_cents / 100);
    } catch {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(row.price_cents / 100);
    }
  }
}
