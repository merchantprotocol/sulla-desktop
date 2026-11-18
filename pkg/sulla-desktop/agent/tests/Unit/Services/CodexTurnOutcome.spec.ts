// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { CodexNoticeClassifier, CodexTurnOutcome } from '../../../languagemodels/codexTurnOutcome';

const HEADS_UP = 'Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.';

describe('CodexNoticeClassifier', () => {
  const classifier = new CodexNoticeClassifier();

  it('treats the long-thread advisory as a notice', () => {
    expect(classifier.isNotice(HEADS_UP)).toBe(true);
  });

  it('treats compaction and new-thread advisories as notices', () => {
    expect(classifier.isNotice('Context compaction ran; quality may drop.')).toBe(true);
    expect(classifier.isNotice('Start a new thread when possible.')).toBe(true);
  });

  it('does not treat real failures as notices', () => {
    expect(classifier.isNotice('Stream disconnected before completion')).toBe(false);
    expect(classifier.isNotice('unexpected status 500 from model')).toBe(false);
    expect(classifier.isNotice('')).toBe(false);
    expect(classifier.isNotice(undefined)).toBe(false);
  });
});

describe('CodexTurnOutcome', () => {
  it('a notice error followed by turn.completed is a success, not fatal', () => {
    const outcome = new CodexTurnOutcome();
    expect(outcome.recordErrorEvent(HEADS_UP)).toBe('notice');
    outcome.recordCompletion();
    expect(outcome.completed).toBe(true);
    expect(outcome.fatal).toBe(false);
  });

  it('a real error followed by no completion is fatal', () => {
    const outcome = new CodexTurnOutcome();
    expect(outcome.recordErrorEvent('Stream disconnected before completion')).toBe('error');
    expect(outcome.completed).toBe(false);
    expect(outcome.fatal).toBe(true);
  });

  it('a real error followed by turn.completed is not fatal (turn finished)', () => {
    const outcome = new CodexTurnOutcome();
    outcome.recordErrorEvent('Stream disconnected before completion');
    outcome.recordCompletion();
    expect(outcome.fatal).toBe(false);
  });

  it('an error event with no message and no completion is fatal', () => {
    const outcome = new CodexTurnOutcome();
    outcome.recordErrorEvent(undefined);
    expect(outcome.fatal).toBe(true);
  });

  it('a notice with no completion is not fatal by itself', () => {
    const outcome = new CodexTurnOutcome();
    outcome.recordErrorEvent(HEADS_UP);
    expect(outcome.fatal).toBe(false);
  });

  it('turn.failed is fatal even when a completion was seen earlier', () => {
    const outcome = new CodexTurnOutcome();
    outcome.recordCompletion();
    outcome.recordTurnFailed();
    expect(outcome.fatal).toBe(true);
  });

  it('turn.failed with no prior events is fatal', () => {
    const outcome = new CodexTurnOutcome();
    outcome.recordTurnFailed();
    expect(outcome.fatal).toBe(true);
  });

  it('a clean run with only a completion is not fatal', () => {
    const outcome = new CodexTurnOutcome();
    outcome.recordCompletion();
    expect(outcome.fatal).toBe(false);
  });
});
