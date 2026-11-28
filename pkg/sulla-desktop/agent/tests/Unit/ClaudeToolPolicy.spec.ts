// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { ACTING_NATIVE_TOOL_DENYLIST, BASE_DISALLOWED_TOOLS, ClaudeToolPolicy, DELEGATED_NATIVE_TOOL_DENYLIST, SUBCONSCIOUS_NATIVE_TOOL_DENYLIST, SUPPORT_NATIVE_TOOL_DENYLIST } from '../../languagemodels/claudeToolPolicy';

describe('delegated Claude native-tool policy', () => {
  const policy = new ClaudeToolPolicy();

  it('denies detached-work and direct-human tools while preserving synchronous Sulla CLI tools', () => {
    // risk: permissions — delegated agents must retain the session-bound parent-first decision tool without regaining detached work or direct control.
    const denied = policy.disallowedToolsFor({ isSubAgent: true, modelSlot: 'primary' }).split(' ');
    expect(denied).toEqual(expect.arrayContaining(DELEGATED_NATIVE_TOOL_DENYLIST.split(' ')));
    expect(denied).toEqual(expect.arrayContaining(BASE_DISALLOWED_TOOLS.split(' ')));
    expect(denied).toContain('AskUserQuestion');
    expect(denied).not.toContain('mcp__sulla-native__ask_user_question');
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
    // risk: observer memory agents accidentally regain action tools, including the question card now enabled for delegated workers.
    const denied = policy.disallowedToolsFor({ modelSlot: 'subconscious', isSubAgent: true }).split(' ');
    expect(denied).toEqual(expect.arrayContaining(BASE_DISALLOWED_TOOLS.split(' ')));
    expect(denied).toEqual(expect.arrayContaining(SUBCONSCIOUS_NATIVE_TOOL_DENYLIST.split(' ')));
    expect(denied).not.toContain('SendMessage');
    expect(denied).toContain('mcp__sulla-native__ask_user_question');
  });

  it('restricts support chats to the gated Sulla support RPC transport', () => {
    // risk: permissions — remote support must not get the normal filesystem, network, browser, or code-editing tools.
    const denied = policy.disallowedToolsFor({ supportSessionId: 'support-session-12345678' }).split(' ');
    expect(denied).toEqual(expect.arrayContaining(SUPPORT_NATIVE_TOOL_DENYLIST.split(' ')));
    expect(denied).toContain('Bash');
  });
});
