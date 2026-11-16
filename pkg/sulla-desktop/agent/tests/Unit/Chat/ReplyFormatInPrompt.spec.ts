// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

// The observational-memory section reads Postgres; a unit run has no database,
// and the settings secret would wait for one until the test times out.
vi.mock('../../../database/models/ObservationsModel', () => ({ ObservationsModel: { listActive: async() => [] } }));
vi.mock('../../../database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { get: async(_key: string, fallback: unknown) => fallback } }));

import '../../../prompts/sections';
import { SystemPromptBuilder, type PromptBuildContext } from '../../../prompts/SystemPromptBuilder';

describe('reply_format prompt section', () => {
  // risk: the chat renderer styles report sections that the agent was never told to write
  it('is part of the full chat prompt sent to model providers', async() => {
    const ctx: PromptBuildContext = {
      mode: 'full', agentId: 'reply-format-test', agentConfig: null, provider: 'anthropic', chatMode: 'text',
      trustLevel: 'trusted', isSubAgent: false, isHeartbeat: false, wsChannel: 'sulla-desktop',
      templateVars: {}, agentSectionOverrides: new Map(), excludeSections: new Set(), basePrompt: '',
    };
    const built = await SystemPromptBuilder.build(ctx);

    expect(built.includedSections).toContain('reply_format');
    expect(built.text).toContain('## Issues found');
  });
});
