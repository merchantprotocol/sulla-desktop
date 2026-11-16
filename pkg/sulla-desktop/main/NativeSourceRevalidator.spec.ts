// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

import { NativeSourceRevalidator } from './NativeSourceRevalidator';

describe('NativeSourceRevalidator', () => {
  it('splits large active-session inventories into Files API pages of at most 256', async() => {
    // risk: availability — a large number of selected files must not block Files unlock.
    const post = vi.fn(async(_handles:string[]) => ({ ok: true, status: 204 }));
    const revalidator = new NativeSourceRevalidator({ post });

    await revalidator.revalidate(Array.from({ length: 513 }, (_, index) => `handle-${ index }`));

    expect(post.mock.calls.map(([handles]) => handles.length)).toEqual([256, 256, 1]);
    expect(post.mock.calls.flatMap(([handles]) => handles)).toHaveLength(513);
  });

  it('submits an empty page to invalidate persisted handles after a process restart', async() => {
    // risk: stale authorization — prior-process native handles must not remain trusted.
    const post = vi.fn(async(_handles:string[]) => ({ ok: true, status: 204 }));

    await new NativeSourceRevalidator({ post }).revalidate([]);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith([]);
  });

  it('keeps native features degraded when one page cannot be revalidated', async() => {
    // risk: authorization — a failed page must never be treated as a valid session.
    const post = vi.fn().mockResolvedValueOnce({ ok: true, status: 204 }).mockResolvedValueOnce({ ok: false, status: 503 });

    await expect(new NativeSourceRevalidator({ post }).revalidate(Array.from({ length: 257 }, () => 'x')))
      .rejects.toThrow('Native source sessions could not be revalidated (503)');
    expect(post).toHaveBeenCalledTimes(2);
  });
});
