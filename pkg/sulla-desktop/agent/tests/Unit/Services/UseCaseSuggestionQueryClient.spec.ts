// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { IpcUseCaseSuggestionQuery } from '../../../services/UseCaseSuggestionQueryClient';

describe('IpcUseCaseSuggestionQuery', () => {
  it('crosses the dedicated recall channel with type and allowlist filters', async() => {
    // risk: process boundary — agent recall must query main-owned vectors via the recall IPC, not local state
    const items = [{ type: 'agent' as const, slug: 'writer', title: 'Writer', description: 'Writes', score: 0.84, reason: 'semantic match' }];
    const invoke = vi.fn(async() => ({ items, ms: 7 }));
    const query = new IpcUseCaseSuggestionQuery({ invoke });
    expect(await query.query('draft a memo', { types: ['agent'], allowedSlugs: ['writer'], limit: 50 })).toEqual(items);
    expect(invoke).toHaveBeenCalledWith('use-case-recall:query', 'draft a memo', { types: ['agent'], allowedSlugs: ['writer'], limit: 50 });
  });
});
