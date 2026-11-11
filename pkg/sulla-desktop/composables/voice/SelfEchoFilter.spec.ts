// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { SelfEchoFilter } from './SelfEchoFilter';
import { VoiceBargeInPolicy } from './VoiceBargeInPolicy';
import { createVoiceTurnAccumulator, TranscriptNoiseFilter } from './VoiceTurnAccumulator';

describe('TranscriptNoiseFilter repetition handling', () => {
  const filter = new TranscriptNoiseFilter();
  it('drops repeated short n-grams and low-diversity noise', () => {
    expect(filter.isNoise('come on come on come on')).toBe(true);
    expect(filter.isNoise('the the the the the')).toBe(true);
  });
  it('keeps meaningful repeated speech with a distinct word', () => {
    expect(filter.isNoise('no no no stop')).toBe(false);
  });
});

describe('SelfEchoFilter', () => {
  it("treats Sulla's own recently spoken words as echo and the user's words as speech", () => {
    let t = 0; const f = new SelfEchoFilter({ now: () => t });
    f.recordSpoken('I got that, so voice is sending now. The install worked.');
    expect(f.isEcho('voice is sending now the install')).toBe(true);
    expect(f.isEcho('stop and check my calendar')).toBe(false);
  });

  it('forgets spoken text after playback plus the tail', () => {
    let t = 0; const f = new SelfEchoFilter({ now: () => t, tailMs: 1000, secondsPerWord: 0.5 });
    f.recordSpoken('the install worked');
    t = 1000 + 3 * 500 + 1; // 3 words of playback + tail
    expect(f.isEcho('the install worked')).toBe(false);
  });

  it('keeps queued speech recognizable when synthesis delays playback past the enqueue estimate', () => {
    // risk: self-echo misclassification after delayed synthesis
    let t = 0;
    const f = new SelfEchoFilter({ now: () => t, tailMs: 100, secondsPerWord: 0.01 });
    f.recordSpoken('the weather is sunny');
    t = 1000; // TTS did not produce its first sample until after the enqueue-based expiry.
    f.playbackStarted();
    expect(f.isEcho('the weather is sunny')).toBe(true);
  });

  it('keeps slow spoken audio recognizable through playback end and its tail', () => {
    let t = 0;
    const f = new SelfEchoFilter({ now: () => t });
    f.recordSpoken('the weather is sunny and the sky is clear');
    f.playbackStarted();
    t = 11_000; // 9 words took 11 seconds; the default rate plus tail would have expired.
    expect(f.isEcho('the weather is sunny and the sky is clear')).toBe(true);
    f.playbackEnded();
    expect(f.isEcho('the weather is sunny and the sky is clear')).toBe(true);
    t += 6001;
    expect(f.isEcho('the weather is sunny and the sky is clear')).toBe(false);
  });

  it('strips a middle echo span while preserving user words around it', () => {
    // risk: mixed speech causes either echoed content or user words to be dropped
    const f = new SelfEchoFilter();
    f.recordSpoken('Here is your schedule for today');
    expect(f.stripEchoSpans('please here is your schedule for today stop')).toBe('please stop');
  });

  it('preserves full user replies after playback when they share only common short phrases', () => {
    // risk: user speech is silently corrupted by common two- or three-word overlaps
    const cases = [
      {
        spoken: 'I can do the review now, it is in the queue.',
        reply: 'Can you put it in the queue for tomorrow morning?',
      },
      {
        spoken: 'We have a couple of options, and I am ready to explain them.',
        reply: 'I am the one who can help you with the options later.',
      },
      {
        spoken: 'The report is up to date, and we can review it after lunch.',
        reply: 'Can you tell me what we can review tomorrow instead?',
      },
      {
        spoken: 'She said she would send it tomorrow, and the final version is ready.',
        reply: "That's not the one I approved; I need the final version now.",
      },
    ];

    for (const { spoken, reply } of cases) {
      const f = new SelfEchoFilter();
      f.recordSpoken(spoken);
      f.playbackStarted();
      f.playbackEnded();
      expect(f.stripEchoSpans(reply)).toBe(reply);
    }
  });

  it('preserves full barge-in transcripts when only common short phrases overlap', () => {
    // risk: barge-in transcript words are removed while Sulla is still speaking
    const cases = [
      {
        spoken: 'I can do the review now, it is in the queue.',
        interruption: 'Can you put it in the queue for tomorrow morning?',
      },
      {
        spoken: 'I am going to check the schedule and call you back.',
        interruption: 'I am asking you to move my meeting, not cancel it.',
      },
      {
        spoken: 'The report is up to date, and we can review it after lunch.',
        interruption: 'Can you tell me what we can review tomorrow instead?',
      },
    ];

    for (const { spoken, interruption } of cases) {
      const f = new SelfEchoFilter();
      f.recordSpoken(spoken);
      f.playbackStarted();
      expect(f.stripEchoSpans(interruption)).toBe(interruption);
    }
  });

  it("doesn't expand possessive apostrophe-s into 'is'", () => {
    // risk: transcript matching falsely aliases a person's possessive as spoken content
    const f = new SelfEchoFilter();
    f.recordSpoken("Jonathon's notes are ready");
    expect(f.isEcho('Jonathon is unavailable')).toBe(false);
  });

  it('normalizes spoken numbers written as digits against number words from STT', () => {
    // risk: echo evasion from spoken number normalization
    const f = new SelfEchoFilter();
    f.recordSpoken('Your meeting is at 3 pm');
    expect(f.isEcho('your meeting is at three pm')).toBe(true);
  });

  it('normalizes common contractions against their expanded STT form', () => {
    // risk: echo evasion from transcript normalization
    const f = new SelfEchoFilter();
    f.recordSpoken("You're right, don't worry");
    expect(f.isEcho('you are right do not worry')).toBe(true);
  });

  it('recognizes the two live Mac reply fixtures across short Whisper chunks', () => {
    // risk: committed self-echo fragments that differ in casing, numbers, or contractions
    const fixtures = [
      {
        spoken: "When the new voice ID code tagged it as voice 1, a new voice that it's not sure ...",
        chunks: ['When the new voice ID code tagged it as voice one', "a new voice that it is not sure"],
      },
      {
        spoken: "And the app transcribed them as if you had said that that's the end.",
        chunks: ['And the app transcribed them', 'as if you had said that that is the end'],
      },
    ];
    for (const fixture of fixtures) {
      const f = new SelfEchoFilter();
      f.recordSpoken(fixture.spoken);
      for (const chunk of fixture.chunks) expect(f.isEcho(chunk)).toBe(true);
    }
  });

  it('matches casing and punctuation variants without changing the spoken words', () => {
    const f = new SelfEchoFilter();
    f.recordSpoken('Hello, WORLD!');
    expect(f.isEcho('hello world')).toBe(true);
  });

  it('keeps the non-echo surface token after removing a contracted echo span', () => {
    const f = new SelfEchoFilter();
    f.recordSpoken("You're right");
    expect(f.stripEchoSpans("you're right stop")).toBe('stop');
  });

  it('removes a short mixed echo without discarding the user interruption', () => {
    // risk: mixed echo suppression must preserve user interruption
    const f = new SelfEchoFilter();
    f.recordSpoken('go now');
    expect(f.stripEchoSpans('go now stop')).toBe('stop');
  });

  it('preserves a genuine user interruption after stripping Sulla speech', () => {
    vi.useFakeTimers();
    try {
      const echo = new SelfEchoFilter({ now: () => Date.now() });
      const policy = new VoiceBargeInPolicy(echo, new TranscriptNoiseFilter());
      let isPlaying = true;
      const onCommit = vi.fn();
      const turn = createVoiceTurnAccumulator({
        onInterim: () => {}, onCommit, isTTSPlaying: () => isPlaying,
        isEcho: t => echo.isEcho(t), stripEcho: t => echo.stripEchoSpans(t), now: () => Date.now(),
      });
      echo.recordSpoken('Here is your schedule for today');
      const userWords = policy.userWords('here is your schedule for today stop');
      expect(userWords).toBe('stop');
      expect(policy.userWords('here is your schedule for today')).toBe('');
      isPlaying = false; // The real adapter stops TTS before passing the retained words onward.
      echo.clear();
      turn.handleEvent({ event_type: 'transcript_turn', text: userWords });
      vi.advanceTimersByTime(5000);
      expect(onCommit).toHaveBeenCalledWith('stop');
    } finally { vi.useRealTimers(); }
  });

  it('echo picked up by the mic never becomes a user turn', () => {
    vi.useFakeTimers();
    try {
      const echo = new SelfEchoFilter({ now: () => Date.now() });
      const onCommit = vi.fn();
      const turn = createVoiceTurnAccumulator({
        onInterim: () => {}, onCommit, isTTSPlaying: () => false, isEcho: t => echo.isEcho(t), now: () => Date.now(),
      });
      echo.recordSpoken('Here is your schedule for today.');
      turn.handleEvent({ event_type: 'transcript_turn', text: 'here is your schedule for today' });
      turn.handleEvent({ event_type: 'utterance_end' });
      vi.advanceTimersByTime(5000);
      expect(onCommit).not.toHaveBeenCalled();
      turn.handleEvent({ event_type: 'transcript_turn', text: 'move my three o clock meeting' });
      vi.advanceTimersByTime(1500);
      expect(onCommit).toHaveBeenCalledWith('move my three o clock meeting');
    } finally { vi.useRealTimers(); }
  });
});
