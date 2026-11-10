// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { MarketplaceBrowseRowMapper } from './MarketplaceBrowseRowMapper';

const baseRow = {
  id:             'tpl_1',
  kind:           'skill',
  slug:           'ledgerline',
  name:           'Ledgerline',
  version:        '1.0.0',
  tags:           ['finance'],
  bundle_size:    1024,
  download_count: 3,
  created_at:     '2026-01-01T00:00:00Z',
  updated_at:     '2026-01-02T00:00:00Z',
};

describe('MarketplaceBrowseRowMapper', () => {
  const mapper = new MarketplaceBrowseRowMapper();

  it('passes valid facets and every other field through unchanged', () => {
    const raw = {
      ...baseRow,
      price_cents:            1500,
      currency:               'USD',
      video_url:              'https://cdn.example.test/demo.mp4',
      video_duration_seconds: 42,
      poster_url:             'https://cdn.example.test/poster.jpg',
      photos:                 ['https://cdn.example.test/a.png'],
      requires_apps:          ['gmail', 'slack'],
      approval_mode:          'drafts_only',
      topic:                  'finance',
    };

    const out = mapper.map(raw);

    expect(out).toEqual(raw);
  });

  it('keeps price 0 as Free and accepts both approval modes', () => {
    expect(mapper.map({ ...baseRow, price_cents: 0 }).price_cents).toBe(0);
    expect(mapper.map({ ...baseRow, approval_mode: 'acts' }).approval_mode).toBe('acts');
  });

  it('drops wrongly typed values to null or [] and never invents data', () => {
    const out = mapper.map({
      ...baseRow,
      price_cents:            '1500',
      currency:               42,
      video_url:              'javascript:alert(1)',
      video_duration_seconds: -5,
      poster_url:             '/relative/poster.jpg',
      photos:                 'https://cdn.example.test/a.png',
      requires_apps:          ['gmail', 7],
      approval_mode:          'auto',
      topic:                  { key: 'finance' },
    });

    expect(out.price_cents).toBeNull();
    expect(out.currency).toBeNull();
    expect(out.video_url).toBeNull();
    expect(out.video_duration_seconds).toBeNull();
    expect(out.poster_url).toBeNull();
    expect(out.photos).toEqual([]);
    expect(out.requires_apps).toEqual([]);
    expect(out.approval_mode).toBeNull();
    expect(out.topic).toBeNull();
  });

  it('rejects non-finite numbers', () => {
    expect(mapper.map({ ...baseRow, price_cents: Number.NaN }).price_cents).toBeNull();
    expect(mapper.map({ ...baseRow, video_duration_seconds: Number.POSITIVE_INFINITY }).video_duration_seconds).toBeNull();
  });

  it('trims strings and turns blank strings into null', () => {
    const out = mapper.map({ ...baseRow, currency: '  USD ', topic: '   ', video_url: '  https://cdn.example.test/v.mp4 ' });

    expect(out.currency).toBe('USD');
    expect(out.topic).toBeNull();
    expect(out.video_url).toBe('https://cdn.example.test/v.mp4');
  });

  it('keeps absent facets absent instead of adding keys', () => {
    const out = mapper.map(baseRow);

    expect(Object.keys(out)).toEqual(Object.keys(baseRow));
    expect('price_cents' in out).toBe(false);
    expect('photos' in out).toBe(false);
    expect('approval_mode' in out).toBe(false);
  });

  it('normalizes facets on a detail response using the same mapper as browse rows', () => {
    const detail = { ...baseRow, manifest: {}, price_cents: 'free', video_url: 'javascript:bad()', photos: ['https://cdn.example.test/a.jpg'], approval_mode: 'drafts_only' };
    const mapped = mapper.map(detail);
    expect(mapped.price_cents).toBeNull();
    expect(mapped.video_url).toBeNull();
    expect(mapped.photos).toEqual(['https://cdn.example.test/a.jpg']);
    expect(mapped.approval_mode).toBe('drafts_only');
  });

  it('does not mutate the raw row', () => {
    const raw = { ...baseRow, price_cents: 'bad' };

    mapper.map(raw);

    expect(raw.price_cents).toBe('bad');
  });
});
