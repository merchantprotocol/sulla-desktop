// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { isOverheardProtocolTurn, stripProtocolTags, stripProtocolTagsStreaming } from '../stripProtocolTags';

describe('overheard protocol', () => {
  const turn = '<overheard>Other speaker; price is $40.</overheard><AGENT_DONE></AGENT_DONE>';

  it('keeps the private marker detectable while emitting no complete or streaming text', () => {
    expect(isOverheardProtocolTurn(turn)).toBe(true);
    expect(stripProtocolTags(turn)).toBe('');
    expect(stripProtocolTagsStreaming('<overheard>Other speaker;')).toBe('');
    expect(stripProtocolTagsStreaming(turn)).toBe('');
  });
});
