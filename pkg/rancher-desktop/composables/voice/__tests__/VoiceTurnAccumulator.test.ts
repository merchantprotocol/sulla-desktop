import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { createVoiceTurnAccumulator } from '../VoiceTurnAccumulator';

describe('VoiceTurnAccumulator', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows partial transcripts without committing them', () => {
    const interim: string[] = [];
    const commits: string[] = [];
    const turn = createVoiceTurnAccumulator({
      onInterim:    text => interim.push(text),
      onCommit:     text => commits.push(text),
      isTTSPlaying: () => false,
    });

    turn.handleEvent({ event_type: 'transcript_partial', text: 'hello' });
    turn.handleEvent({ event_type: 'transcript_partial', text: 'there' });

    expect(interim).toEqual(['hello', 'hello there']);
    expect(commits).toEqual([]);
  });

  it('commits accumulated transcript_turn text on utterance_end', () => {
    jest.useFakeTimers();

    const interim: string[] = [];
    const commits: string[] = [];
    const turn = createVoiceTurnAccumulator({
      onInterim:    text => interim.push(text),
      onCommit:     text => commits.push(text),
      isTTSPlaying: () => false,
      fallbackMs:   8000,
    });

    turn.handleEvent({ event_type: 'transcript_turn', text: 'first half' });
    turn.handleEvent({ event_type: 'transcript_turn', text: 'second half' });

    expect(interim).toEqual(['first half', 'first half second half']);
    expect(commits).toEqual([]);

    turn.handleEvent({ event_type: 'utterance_end', text: '' });

    expect(commits).toEqual(['first half second half']);
    jest.advanceTimersByTime(8000);
    expect(commits).toEqual(['first half second half']);
  });

  it('uses the fallback timer only when utterance_end does not arrive', () => {
    jest.useFakeTimers();

    const commits: string[] = [];
    const turn = createVoiceTurnAccumulator({
      onInterim:    () => {},
      onCommit:     text => commits.push(text),
      isTTSPlaying: () => false,
      fallbackMs:   8000,
    });

    turn.handleEvent({ event_type: 'transcript_turn', text: 'do not split me' });

    jest.advanceTimersByTime(7999);
    expect(commits).toEqual([]);

    jest.advanceTimersByTime(1);
    expect(commits).toEqual(['do not split me']);
  });

  it('drops transcript text while TTS is playing', () => {
    const interim: string[] = [];
    const commits: string[] = [];
    const turn = createVoiceTurnAccumulator({
      onInterim:    text => interim.push(text),
      onCommit:     text => commits.push(text),
      isTTSPlaying: () => true,
    });

    turn.handleEvent({ event_type: 'transcript_turn', text: 'sulla speaking' });
    turn.handleEvent({ event_type: 'utterance_end', text: '' });

    expect(interim).toEqual([]);
    expect(commits).toEqual(['']);
  });

  it('reset clears pending text and timers', () => {
    jest.useFakeTimers();

    const commits: string[] = [];
    const turn = createVoiceTurnAccumulator({
      onInterim:    () => {},
      onCommit:     text => commits.push(text),
      isTTSPlaying: () => false,
      fallbackMs:   8000,
    });

    turn.handleEvent({ event_type: 'transcript_turn', text: 'discard me' });
    turn.reset();
    jest.advanceTimersByTime(8000);

    expect(commits).toEqual([]);
  });
});
