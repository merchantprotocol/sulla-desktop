// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalAddressedSpeechClassifier } from './AddressedSpeechClassifier';
import { SelfEchoFilter } from './SelfEchoFilter';
import { createVoiceTurnAccumulator, TranscriptNoiseFilter } from './VoiceTurnAccumulator';

function setup() {
  const onCommit = vi.fn();
  const turn = createVoiceTurnAccumulator({
    onInterim: () => {}, onCommit, isTTSPlaying: () => false, now: () => Date.now(),
  });
  return { turn, onCommit };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('VoiceTurnAccumulator end of turn', () => {
  it('commits when background noise keeps VAD speaking forever', () => {
    const { turn, onCommit } = setup();
    turn.handleEvent({ event_type: 'transcript_turn', text: 'what is on my calendar today' });
    for (let i = 0; i < 200; i++) { turn.speechStarted(); vi.advanceTimersByTime(16); }
    expect(onCommit).toHaveBeenCalledWith('what is on my calendar today');
  });

  it('does not cut the user off while new words keep arriving', () => {
    const { turn, onCommit } = setup();
    turn.handleEvent({ event_type: 'transcript_partial', text: 'remind me to' });
    vi.advanceTimersByTime(1000);
    turn.handleEvent({ event_type: 'transcript_partial', text: 'call the bank' });
    vi.advanceTimersByTime(1000);
    expect(onCommit).not.toHaveBeenCalled();
    turn.handleEvent({ event_type: 'transcript_turn', text: 'remind me to call the bank tomorrow' });
    vi.advanceTimersByTime(1500);
    expect(onCommit).toHaveBeenCalledWith('remind me to call the bank tomorrow');
  });

  it('keeps every partial chunk when no final transcript arrives', () => {
    const { turn, onCommit } = setup();
    turn.handleEvent({ event_type: 'transcript_partial', text: 'first part' });
    turn.handleEvent({ event_type: 'transcript_partial', text: 'second part' });
    vi.advanceTimersByTime(1500);
    expect(onCommit).toHaveBeenCalledWith('first part second part');
  });

  it('noise hallucinations and repeated chunks do not hold the turn open', () => {
    const { turn, onCommit } = setup();
    turn.handleEvent({ event_type: 'transcript_turn', text: 'send the report' });
    vi.advanceTimersByTime(1000);
    turn.handleEvent({ event_type: 'transcript_partial', text: '[BLANK_AUDIO]' });
    turn.handleEvent({ event_type: 'transcript_partial', text: 'Thank you.' });
    vi.advanceTimersByTime(500);
    expect(onCommit).toHaveBeenCalledWith('send the report');
  });

  it('waits longer when the user trails off mid-thought', () => {
    const { turn, onCommit } = setup();
    turn.handleEvent({ event_type: 'transcript_turn', text: 'book a table for two and' });
    vi.advanceTimersByTime(1500);
    expect(onCommit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(onCommit).toHaveBeenCalledWith('book a table for two and');
  });

  it('utterance_end commits sooner than the words-stable deadline', () => {
    const { turn, onCommit } = setup();
    turn.handleEvent({ event_type: 'transcript_turn', text: 'turn on the lights' });
    turn.handleEvent({ event_type: 'utterance_end' });
    vi.advanceTimersByTime(700);
    expect(onCommit).toHaveBeenCalledWith('turn on the lights');
  });
});

describe('VoiceTurnAccumulator default timers', () => {
  it('commits with browser-strict timers that reject a foreign `this` (Chromium Illegal invocation)', () => {
    vi.useRealTimers();
    const realSet = globalThis.setTimeout; const realClear = globalThis.clearTimeout;
    const pending: Array<() => void> = [];
    const strictSet = function (this: unknown, fn: () => void) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      pending.push(fn); return pending.length as any;
    };
    const strictClear = function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    };
    vi.stubGlobal('setTimeout', strictSet); vi.stubGlobal('clearTimeout', strictClear);
    try {
      const onCommit = vi.fn();
      const turn = createVoiceTurnAccumulator({ onInterim: () => {}, onCommit, isTTSPlaying: () => false });
      expect(() => turn.handleEvent({ event_type: 'transcript_turn', text: 'are you there' })).not.toThrow();
      expect(() => turn.handleEvent({ event_type: 'utterance_end' })).not.toThrow();
      pending.at(-1)?.();
      expect(onCommit).toHaveBeenCalledWith('are you there');
    } finally {
      vi.unstubAllGlobals(); globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear;
    }
  });
});

describe('voice address and echo policies', () => {
  it('recognizes direct address and immediate conversational continuation, but not room speech', () => {
    const classifier = new LocalAddressedSpeechClassifier();
    expect(classifier.isAddressed('Hey Sulla, set a timer')).toBe(true);
    expect(classifier.isAddressed('Why did that happen?', { sincePlaybackEndMs: 4000 })).toBe(true);
    expect(classifier.isAddressed('The phone call is over')).toBe(false);
    expect(classifier.isAddressed('random words', { holdToTalk: true })).toBe(true);
  });

  it('strips an echoed phrase at the edge while retaining the user words', () => {
    const filter = new SelfEchoFilter({ now: () => 1000 });
    filter.recordSpoken('Your call sounded like it wrapped up');
    expect(filter.stripEchoSpans('Your call sounded like it wrapped up oh yeah totally did')).toBe('oh yeah totally did');
  });
});

describe('TranscriptNoiseFilter', () => {
  it('keeps real speech and drops tag-only or hallucinated text', () => {
    const f = new TranscriptNoiseFilter();
    expect(f.isNoise('[BLANK_AUDIO]')).toBe(true);
    expect(f.isNoise('(background noise)')).toBe(true);
    expect(f.isNoise('Thank you.')).toBe(true);
    expect(f.isNoise('thank you for the update on the project')).toBe(false);
    expect(f.isNoise('so what time is it')).toBe(false);
  });
});
