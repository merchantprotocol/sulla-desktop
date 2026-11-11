// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { SkillRecallService } from '../../../services/SkillRecall';

describe('SkillRecallService catalog cache', () => {
  it('reuses the catalog and returns fresh data after invalidation', async() => {
    // risk: stale capability discovery — installed/updated skills become discoverable after cache invalidation
    let catalog = [] as any[];
    const load = vi.fn(async() => catalog);
    const service = new SkillRecallService(load, 60_000, () => 1);
    await service.buildContext('summarize a document');
    await service.buildContext('summarize another document');
    expect(load).toHaveBeenCalledTimes(1);
    catalog = [{ slug: 'summarize-document', title: 'Summarize document', description: 'summarize document', tags: [], triggers: [] }];
    await service.invalidate();
    const context = await service.buildContext('summarize a document');
    expect(load).toHaveBeenCalledTimes(2);
    expect(context).toContain('[skill:summarize-document]');
  });
});
