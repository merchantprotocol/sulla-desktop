// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { splitSpeakSentences } from '../SpeakExtractor';

describe('speak sentence chunker', () => {
  it('sends a short first sentence on its own so audio starts sooner', () => {
    expect(splitSpeakSentences('Sure, one sec. Let me', true)).toEqual({ sentences: ['Sure, one sec.'], consumed: 15 });
  });

  it('keeps later short fragments attached to the next sentence', () => {
    const buffer = 'Got it. Yes. That one is on your calendar for Friday. ';
    expect(splitSpeakSentences(buffer, true).sentences).toEqual(['Got it.', 'Yes. That one is on your calendar for Friday.']);
    expect(splitSpeakSentences('Yes. That one is on your calendar for Friday. ', false).sentences)
      .toEqual(['Yes. That one is on your calendar for Friday.']);
  });

  it('waits for whitespace after the punctuation', () => {
    expect(splitSpeakSentences('It costs 3.5 dollars', true)).toEqual({ sentences: [], consumed: 0 });
    expect(splitSpeakSentences('Okay.', true)).toEqual({ sentences: [], consumed: 0 });
  });

  it('does not split after an abbreviation', () => {
    expect(splitSpeakSentences('Ask Dr. Smith about it tomorrow. ', true).sentences).toEqual(['Ask Dr. Smith about it tomorrow.']);
  });

  it('holds a fragment too short to speak alone', () => {
    expect(splitSpeakSentences('Hi. ', true)).toEqual({ sentences: [], consumed: 0 });
  });
});
