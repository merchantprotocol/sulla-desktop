// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { BASE_DISALLOWED_TOOLS, DELEGATED_NATIVE_TOOL_DENYLIST, disallowedToolsFor } from '../../../languagemodels/claudeToolPolicy';

describe('delegated Claude native-tool policy', () => {
  it('denies detached-work and direct-human tools while preserving synchronous Sulla CLI tools', () => {
    // risk: delegated agents bypass the graph or interrupt the human directly
    const denied = disallowedToolsFor({ isSubAgent: true, modelSlot: 'primary' }).split(' ');
    expect(denied).toEqual(expect.arrayContaining(DELEGATED_NATIVE_TOOL_DENYLIST.split(' ')));
    expect(denied).toEqual(expect.arrayContaining(BASE_DISALLOWED_TOOLS.split(' ')));
    expect(denied).not.toContain('Bash');
    expect(denied).not.toContain('Read');
    expect(denied).not.toContain('Edit');
    expect(denied).not.toContain('Write');
  });

  it('keeps ordinary primary agents on the existing base policy', () => {
    // risk: the new worker restriction accidentally removes tools from human-facing runs
    expect(disallowedToolsFor({ modelSlot: 'primary' })).toBe(BASE_DISALLOWED_TOOLS);
  });
});
