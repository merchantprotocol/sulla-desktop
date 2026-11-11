// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { SkillRecallService } from '../../../services/SkillRecall';
import type { UseCaseSuggestionQuery } from '../../../services/UseCaseSuggestionQueryClient';

describe('SkillRecallService', () => {
  it('queries only published indexed skills and formats the existing context block', async() => {
    // risk: published-only skill recall and preserving the skill ID used by the loader
    const query = vi.fn<UseCaseSuggestionQuery['query']>(async(_text, _options) => [
      { type: 'skill' as const, slug: 'summarize-document', title: 'Summarize document', description: 'Summarize a long document.', score: 0.03, reason: 'semantic match' },
    ]);
    const service = new SkillRecallService({ query });
    const context = await service.buildContext('Need a document summary');
    expect(query).toHaveBeenCalledWith('Need a document summary', { types: ['skill'], limit: 4 });
    expect(context).toContain('[skill:summarize-document] Summarize document');
    expect(context).toContain('semantic suggestion');
  });

  it('does not query blank text and emits no block when there are no suggestions', async() => {
    // risk: empty or irrelevant prompts must not inject unrelated skill capabilities
    const query = vi.fn(async() => []);
    const service = new SkillRecallService({ query });
    expect(await service.buildContext('  ')).toBe('');
    expect(query).not.toHaveBeenCalled();
    expect(await service.buildContext('unrelated request')).toBe('');
  });
});
