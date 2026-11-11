// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { VoiceAgentRouting } from './VoiceAgentRouting';

describe('VoiceAgentRouting', () => {
  const routing = new VoiceAgentRouting();

  it('always routes voice to the fast voice agent and keeps the selected agent for typed chat', () => {
    // risk: core business logic — voice must use the fast agent (it also ignores overheard speech).
    expect(routing.resolve('voice')).toBe('conversationalist');
    expect(routing.resolve('voice', 'my-selected-agent')).toBe('conversationalist');
    expect(routing.resolve(undefined, 'my-selected-agent')).toBe('my-selected-agent');
    expect(routing.resolve(undefined)).toBeUndefined();
  });
});
