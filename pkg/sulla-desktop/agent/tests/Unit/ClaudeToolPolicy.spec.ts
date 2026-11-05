// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { ACTING_NATIVE_TOOL_DENYLIST, BASE_DISALLOWED_TOOLS, ClaudeToolPolicy, DELEGATED_NATIVE_TOOL_DENYLIST, SUBCONSCIOUS_NATIVE_TOOL_DENYLIST } from '../../../languagemodels/claudeToolPolicy';

describe('delegated Claude native-tool policy', () => {
  const policy = new ClaudeToolPolicy();

  it('denies detached-work and direct-human tools while preserving synchronous Sulla CLI tools', () => {
    // risk: delegated agents bypass the graph or interrupt the human directly
    const denied = policy.disallowedToolsFor({ isSubAgent: true, modelSlot: 'primary' }).split(' ');
    expect(denied).toEqual(expect.arrayContaining(DELEGATED_NATIVE_TOOL_DENYLIST.split(' ')));
    expect(denied).toEqual(expect.arrayContaining(BASE_DISALLOWED_TOOLS.split(' ')));
    expect(denied).not.toContain('Bash');
    expect(denied).not.toContain('Read');
    expect(denied).not.toContain('Edit');
    expect(denied).not.toContain('Write');
  });

  it('keeps ordinary primary agents on the existing base policy', () => {
    // risk: primary agents bypass Sulla's graph by directly managing workers
    const denied = policy.disallowedToolsFor({ modelSlot: 'primary' }).split(' ');
    expect(denied).toEqual(expect.arrayContaining(ACTING_NATIVE_TOOL_DENYLIST.split(' ')));
    expect(denied).not.toContain('mcp__sulla-native__ask_user_question');
  });

  it('keeps observers on their unchanged restricted policy', () => {
    // risk: observer memory agents accidentally regain native filesystem or orchestration tools
    const denied = policy.disallowedToolsFor({ modelSlot: 'subconscious', isSubAgent: true }).split(' ');
    expect(denied).toEqual(expect.arrayContaining(BASE_DISALLOWED_TOOLS.split(' ')));
    expect(denied).toEqual(expect.arrayContaining(SUBCONSCIOUS_NATIVE_TOOL_DENYLIST.split(' ')));
    expect(denied).not.toContain('SendMessage');
  });
});
