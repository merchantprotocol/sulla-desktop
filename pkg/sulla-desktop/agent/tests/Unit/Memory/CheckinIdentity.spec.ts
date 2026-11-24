// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { CheckinIdentity } from '../../../memory/CheckinIdentity';

describe('CheckinIdentity', () => {
  it('uses the agent job as the highest-priority orchestrator wake-up identity', () => {
    // risk: dedupe misses a wake-up when multiple identifiers are present
    expect(CheckinIdentity.keyFor({
      id: 'episode-1',
      text: 'Orchestrator wake-up: agent-job-1795493855725-88 resumed in thread_abc123 for draft PR #2816 on the memory cap epic.',
    })).toBe('job:agent-job-1795493855725-88');
  });

  it('identifies a manager status turn about a numbered epic PR', () => {
    // risk: related manager check-ins are stored repeatedly under separate turns
    expect(CheckinIdentity.keyFor({
      id: 'episode-2',
      text: 'Manager status turn: tracking the memory cap epic on draft PR #2816; next step is review.',
    })).toBe('pr:2816');
  });

  it('identifies the repeated detailed chat-trace entry by its epic PR', () => {
    // risk: duplicated timeline check-ins are missed when they use trace wording
    expect(CheckinIdentity.keyFor({
      id: 'episode-trace',
      text: 'Detailed chat trace for the memory cap epic on draft #2816 records ongoing work.',
    })).toBe('pr:2816');
  });

  it('identifies a sub-agent result by its job id', () => {
    // risk: repeated worker result/progress entries survive as separate memory
    expect(CheckinIdentity.keyFor({
      id: 'episode-3',
      text: 'Sub-agent result: agent-job-1795493529023-87 completed its research report.',
    })).toBe('job:agent-job-1795493529023-87');
  });

  it('uses a thread identity when a check-in has no job id', () => {
    // risk: thread-scoped status updates cannot be superseded consistently
    expect(CheckinIdentity.keyFor({
      id: 'episode-4',
      text: 'Heartbeat status update in thread_heartbeat42: resumed and working on the next step.',
    })).toBe('thread:thread_heartbeat42');
  });

  it.each([
    ['human-authored source', { id: 'agent-job-1-2', text: 'Manager status update for agent-job-1-2.', source: 'user' }],
    ['human approval statement', { id: 'episode-5', text: 'Jonathon approved X for agent-job-1795493855725-88; the manager reported progress.' }],
    ['rule statement', { id: 'episode-6', text: 'RULE: keep one check-in per agent-job-1795493855725-88, status reported.' }],
    ['quoted user statement', { id: 'episode-7', text: 'The user said: “keep only the last check-in” for agent-job-1795493855725-88.' }],
    ['speaker-labeled user quote', { id: 'episode-10', text: '> Jonathon: “Keep only the last check-in” for agent-job-1795493855725-88.' }],
    ['missing identity', { id: 'episode-8', text: 'Manager status update: the epic is still in progress.' }],
    ['non-status note with an identity', { id: 'episode-9', text: 'This design note mentions agent-job-1795493855725-88 and describes a layout constraint.' }],
  ])('returns null for %s', (_label, episode) => {
    // risk: dedupe must not erase human intent or merge unrelated observations
    expect(CheckinIdentity.keyFor(episode)).toBeNull();
  });
});
