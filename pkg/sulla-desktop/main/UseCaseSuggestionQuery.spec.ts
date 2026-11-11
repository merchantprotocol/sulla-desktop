// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { USE_CASE_SUGGEST_CHANNEL, UseCaseSuggestionQuery, registerUseCaseSuggestionQuery } from './UseCaseSuggestionQuery';

const row = (type: string, slug: string) => ({ type, slug, title: slug, description: '', score: 0.9, reason: '' });

describe('UseCaseSuggestionQuery', () => {
  it('never asks the index for functions and drops any it returns anyway', async() => {
    // policy: Jonathon's rule — functions are never suggested in the composer
    const suggest = vi.fn(async() => [row('skill', 'report'), row('function', 'send-money'), row('agent', 'inbox'), row('recipe', 'crm')]);
    const result = await new UseCaseSuggestionQuery({ suggest }).query('make a report', { limit: 5 });

    expect(suggest).toHaveBeenCalledWith('make a report', { types: ['skill', 'agent', 'workflow', 'recipe'], limit: 5 });
    expect(result.items.map(item => item.type)).toEqual(['skill', 'agent', 'recipe']);
  });

  it('passes the draft text through unchanged and clamps the limit to 1–5', async() => {
    const suggest = vi.fn(async() => []);
    const query = new UseCaseSuggestionQuery({ suggest });
    await query.query('  email the "Sweeps" leads  ', { limit: 900 });
    await query.query('weekly digest', { limit: 0 });

    expect(suggest).toHaveBeenNthCalledWith(1, '  email the "Sweeps" leads  ', { types: ['skill', 'agent', 'workflow', 'recipe'], limit: 5 });
    expect(suggest).toHaveBeenNthCalledWith(2, 'weekly digest', { types: ['skill', 'agent', 'workflow', 'recipe'], limit: 1 });
  });

  it('does not hit the index for blank or non-string input', async() => {
    const suggest = vi.fn(async() => [row('skill', 'x')]);
    const query = new UseCaseSuggestionQuery({ suggest });

    expect(await query.query({ prompt: 'wrong type' })).toEqual({ items: [], ms: 0 });
    expect(await query.query('   ')).toEqual({ items: [], ms: 0 });
    expect(suggest).not.toHaveBeenCalled();
  });

  it('registers one handler on the suggestion channel that ignores the IPC event', async() => {
    const suggest = vi.fn(async() => [row('workflow', 'digest'), row('function', 'f')]);
    let handler: ((event: unknown, text: unknown, options?: { limit?: unknown }) => Promise<unknown>) | undefined;
    registerUseCaseSuggestionQuery((channel, h) => { expect(channel).toBe(USE_CASE_SUGGEST_CHANNEL); handler = h }, { suggest });

    const result = await handler!({ sender: {} }, 'digest', { limit: 3 }) as { items: { slug: string }[] };
    expect(result.items.map(item => item.slug)).toEqual(['digest']);
    expect(suggest).toHaveBeenCalledWith('digest', { types: ['skill', 'agent', 'workflow', 'recipe'], limit: 3 });
  });
});
