// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

// Reflex is removed from the composer path. If anything in the use-case query
// chain imports a Reflex module, these factories throw and the whole file fails.
vi.mock('../../../reflex/ReflexService', () => { throw new Error('Reflex must not load for use-case suggestions'); });
vi.mock('../../../reflex/ReflexEngine', () => { throw new Error('Reflex must not load for use-case suggestions'); });
vi.mock('../../../reflex/reflexPolicy', () => { throw new Error('Reflex must not load for use-case suggestions'); });

import { UseCaseSuggestionQuery } from '../../../../main/UseCaseSuggestionQuery';
import { IpcUseCaseSuggestionQuery } from '../../../services/UseCaseSuggestionQueryClient';

const row = (type: string, slug: string) => ({ type, slug, title: slug, description: '', score: 0.9, reason: '' });

describe('use-case suggestions without Reflex loaded', () => {
  it('returns composer suggestions through the query path with no Reflex module involved', async() => {
    // risk: composer regression — suggestions must keep working after Reflex removal
    const suggest = vi.fn(async() => [row('skill', 'deploy-skill'), row('function', 'deploy-fn'), row('agent', 'release-agent')]);
    const query = new UseCaseSuggestionQuery({ suggest });

    const response = await query.query('deploy the release', { limit: 5 });

    expect(response.items.map(item => item.slug)).toEqual(['deploy-skill', 'release-agent']);
    expect(suggest).toHaveBeenCalledWith('deploy the release', { types: ['skill', 'agent', 'workflow', 'recipe'], limit: 5 });
  });

  it('the agent-side IPC client forwards the query and returns the items it receives', async() => {
    // risk: agent recall — the agent/main boundary must still deliver suggestions
    const invoke = vi.fn(async() => ({ items: [row('skill', 'deploy-skill')], ms: 1 }));
    const client = new IpcUseCaseSuggestionQuery({ invoke });

    const items = await client.query('deploy the release', { types: ['skill'], limit: 3 });

    expect(invoke).toHaveBeenCalledWith('use-case-recall:query', 'deploy the release', { types: ['skill'], limit: 3 });
    expect(items.map(item => item.slug)).toEqual(['deploy-skill']);
  });
});
