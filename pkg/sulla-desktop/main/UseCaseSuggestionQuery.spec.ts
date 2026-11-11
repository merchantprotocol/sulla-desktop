// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';
import { UseCaseSuggestionQuery } from './UseCaseSuggestionQuery';

describe('UseCaseSuggestionQuery', () => {
  it('keeps functions out of index queries and returned results', async() => {
    // risk: unintended function execution through the composer
    const suggest = vi.fn(async(_text: string, options: { types: string[]; limit: number }) => {
      expect(options.types).not.toContain('function');
      return [
        { type: 'skill' as const, slug: 'report', title: 'Report', description: '', score: 1, reason: '' },
        { type: 'function' as const, slug: 'send', title: 'Send', description: '', score: 0.9, reason: '' },
      ];
    });
    const query = new UseCaseSuggestionQuery({ suggest });
    const result = await query.query('make a report');
    expect(result.items.map(item => item.slug)).toEqual(['report']);
    expect(suggest).toHaveBeenCalledWith('make a report', { types: ['skill', 'agent', 'workflow', 'recipe'], limit: 5 });
  });

  it('normalizes invalid text and clamps a requested limit', async() => {
    // risk: malformed renderer input bypasses index constraints
    const suggest = vi.fn(async() => []);
    const query = new UseCaseSuggestionQuery({ suggest });
    await query.query({ prompt: 'wrong type' }, { limit: 900 });
    expect(suggest).toHaveBeenCalledWith('', { types: ['skill', 'agent', 'workflow', 'recipe'], limit: 5 });
  });
});
