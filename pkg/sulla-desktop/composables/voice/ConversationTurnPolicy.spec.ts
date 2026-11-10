import { describe, expect, it, vi } from 'vitest';
import { HeuristicEndOfTurnDetector, SentenceFragmenter, SpokenReplyGovernor, TurnBuffer } from './ConversationTurnPolicy';
import { createVoiceTurnAccumulator } from './VoiceTurnAccumulator';

describe('voice conversation turn policy', () => {
  it('preserves non-empty transcript segments across pauses', () => {
    // risk: data integrity — resumed speech must not overwrite earlier words.
    const buffer = new TurnBuffer();
    buffer.append('I want a table');
    buffer.append('   ');
    buffer.append('for two');
    expect(buffer.text).toBe('I want a table for two');
  });

  it('extends the end-of-turn hold for unfinished phrases', () => {
    // risk: data integrity — silence after a conjunction must not split a thought.
    const detector = new HeuristicEndOfTurnDetector();
    expect(detector.delayMs('Please book a table', 700)).toBe(700);
    expect(detector.delayMs('Please book a table for', 700)).toBe(1400);
  });

  it('emits complete sentences only and respects spoken word limits', () => {
    // risk: output safety — never cut off speech mid-sentence or exceed the cap.
    const fragmenter = new SentenceFragmenter(6, 2);
    expect(fragmenter.feed('Hello there. How are')).toEqual(['Hello there.']);
    expect(fragmenter.feed(' you today? This is extra.')).toEqual(['How are you today?']);
    expect(fragmenter.finish()).toEqual([]);
  });

  it('rejects invalid limits instead of allowing unbounded speech', () => {
    // risk: output safety — malformed configuration fails closed.
    expect(() => new SentenceFragmenter(0)).toThrow();
  });

  it('caps spoken replies at sentence boundaries and emits one screen notice', () => {
    // risk: output safety — long spoken answers stop cleanly and point to the full text.
    const governor = new SpokenReplyGovernor(7, 2);
    expect(governor.accept('One short line. Another line.')).toEqual({
      fragments: ['One short line.', 'Another line.'], showScreenNotice: false,
    });
    expect(governor.accept('Third sentence.')).toEqual({ fragments: [], showScreenNotice: true });
    expect(governor.accept('Fourth sentence.')).toEqual({ fragments: [], showScreenNotice: false });
  });

  it('holds the turn through resumed speech and commits the merged transcript', () => {
    // risk: data integrity — a follow-up during the silence grace is not lost or split.
    vi.useFakeTimers();
    const commits: string[] = [];
    const turn = createVoiceTurnAccumulator({ onInterim: () => {}, onCommit: text => commits.push(text), isTTSPlaying: () => false });
    turn.handleEvent({ event_type: 'transcript_turn', text: 'Book a table for' });
    turn.handleEvent({ event_type: 'utterance_end' });
    vi.advanceTimersByTime(700);
    expect(commits).toEqual([]);
    turn.speechStarted();
    turn.handleEvent({ event_type: 'transcript_turn', text: 'two people' });
    turn.handleEvent({ event_type: 'utterance_end' });
    vi.advanceTimersByTime(700);
    expect(commits).toEqual(['Book a table for two people']);
    turn.reset();
    vi.useRealTimers();
  });
});
