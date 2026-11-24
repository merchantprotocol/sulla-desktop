// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { CheckinIdentity } from '../../../memory/CheckinIdentity';

const identity = (text: string, overrides: Record<string, unknown> = {}) =>
  CheckinIdentity.keyFor({ id: 'episode-1', text, ...overrides } as {
    id: string;
    text: string;
    source?: string;
    keys?: string[];
    conversationId?: string | null;
    sentiment?: string | null;
  });

describe('CheckinIdentity', () => {
  it('uses the agent job as the highest-priority status identity', () => {
    // risk: duplicate wake-ups remain when the same report names multiple identifier types
    expect(identity('Orchestrator wake-up: agent-job-1795493855725-88 resumed in thread_abc123 for draft PR #2816 on the memory cap epic.'))
      .toBe('job:agent-job-1795493855725-88');
  });

  it('uses a spawn-agent thread identity but rejects arbitrary thread ids', () => {
    // risk: unrelated conversation threads are merged as duplicate status reports
    expect(identity('Heartbeat status update in thread_heartbeat42: resumed.', { conversationId: 'thread_main' }))
      .toBeNull();
    expect(identity('Sub-agent result from spawn-agent-memory-cap-worker completed.'))
      .toBeNull();
    expect(identity('Heartbeat status update: resumed.', { id: 'thread_abc' }))
      .toBeNull();
    expect(identity('Sub-agent result in thread_spawn-agent-memory-cap-worker completed.', { conversationId: 'thread_main' }))
      .toBe('conv:thread_main|thread:spawn-agent-memory-cap-worker');
    expect(identity('Heartbeat status update in thread_agent-job-1795493855725-88 resumed.'))
      .toBe('job:agent-job-1795493855725-88');
  });

  it('keeps two same-template jobs in one conversation separate by job id', () => {
    // risk: different worker jobs in one chat incorrectly supersede each other
    const conversationId = 'thread_spawn_agent_parent';
    const first = identity('Sub-agent result agent-job-1795493855725-88 completed the research task.', { conversationId });
    const second = identity('Sub-agent result agent-job-1795493855725-89 completed the research task.', { conversationId });
    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('scopes the same job identity to each conversation', () => {
    // risk: identical job reports from separate chats supersede each other
    const text = 'Sub-agent result agent-job-1795493855725-88 completed the research task.';
    const first = identity(text, { conversationId: 'thread_chat_a' });
    const second = identity(text, { conversationId: 'thread_chat_b' });
    expect(first).toBe('conv:thread_chat_a|job:agent-job-1795493855725-88');
    expect(second).toBe('conv:thread_chat_b|job:agent-job-1795493855725-88');
    expect(second).not.toBe(first);
  });

  it('does not treat a conversation id as a job identity source', () => {
    // risk: a conversation identifier is mistaken for a worker job and merges episodes
    expect(identity('Worker status update: still running.', { conversationId: 'agent-job-1795493855725-88' }))
      .toBeNull();
  });

  it('returns null when a check-in names multiple distinct job ids', () => {
    // risk: ambiguous reports merge unrelated worker histories
    expect(identity('Worker progress: agent-job-1795493855725-88 and agent-job-1795493855725-89 are active.', { conversationId: 'thread_1' }))
      .toBeNull();
  });

  it('returns null when a check-in names multiple distinct PR numbers', () => {
    // risk: an ambiguous report supersedes status for the wrong PR
    expect(identity('PR #2816 and PR #2817 status update: work continues.', { conversationId: 'thread_1' }))
      .toBeNull();
  });

  it('uses conversation plus PR for common variants and separates a different PR', () => {
    // risk: cross-domain status variants for one PR duplicate, or unrelated PRs merge
    const variants = [
      'PR #2816 status update.',
      'PR#2816 status update.',
      'PR 2816 status update.',
      'PR-2816 status update.',
      'PR:2816 status update.',
      'pull request #2816 progress report.',
      'Pull Request 2816 progress report.',
      'draft PR #2816 check-in.',
      'draft #2816 check-in.',
      'PR #2816 check-in.',
      'PR #2816 status update.',
      'PR #2816 is blocked.',
      'currently working on PR #2816.',
      'manager status turn for PR #2816.',
      'worker progress report on PR #2816.',
      'sub-agent result on PR #2816.',
      'orchestrator wake-up mentions PR #2816.',
      'heartbeat status update for PR #2816.',
      'detailed chat trace in epic #2816.',
      'draft pull request #2816 complete.',
    ];
    const keys = variants.map(text => identity(text, { conversationId: 'thread_chat_2816' }));
    const recognized = keys.filter((key): key is string => key !== null);
    expect(recognized.length).toBeGreaterThanOrEqual(18);
    expect(new Set(recognized).size).toBe(1);
    expect(identity('PR #2817 status update.', { conversationId: 'thread_chat_2816' }))
      .toBe('conv:thread_chat_2816|pr:2817');
  });

  it('requires an explicit PR or draft prefix without conversation context', () => {
    // risk: unqualified issue numbers are mistaken for a PR status identity
    expect(identity('PR #2816 status update.')).toBe('pr:2816');
    expect(identity('#2816 status update.')).toBeNull();
    expect(identity('Detailed chat trace for the memory cap epic #2816 status update.'))
      .toBe('pr:2816');
    expect(identity('draft #2816 check-in.')).toBe('pr:2816');
    expect(identity('pull request #2816 progress report.')).toBe('pr:2816');
    expect(identity('PR #2816 status update.', { conversationId: 'thread_2816' }))
      .toBe('conv:thread_2816|pr:2816');
  });

  it('does not treat a bare numbered step as a PR identity inside a conversation', () => {
    // risk: unrelated numbered work is merged into PR check-in history
    expect(identity('Step #1 completed.', { conversationId: 'thread_chat' })).toBeNull();
  });

  it.each(['approval', 'correction'])('returns null for non-neutral sentiment %s', sentiment => {
    // risk: corrections, approvals, or frustrations are hidden by check-in superseding
    expect(identity('Worker progress update: agent-job-1795493855725-88.', { sentiment })).toBeNull();
  });

  it.each([
    ['human-authored source', 'Manager status update for agent-job-1-2.', { source: 'user' }],
    ['human approval statement', 'Jonathon approved X for agent-job-1795493855725-88; the manager reported progress.', {}],
    ['rule statement', 'RULE: keep one check-in per agent-job-1795493855725-88, status reported.', {}],
    ['DECIDED marker', 'DECIDED: agent-job-1795493855725-88 status update.', {}],
    ['DO NOT marker', 'DO NOT merge agent-job-1795493855725-88; status update.', {}],
    ["DON'T marker", "DON'T merge agent-job-1795493855725-88; status update.", {}],
    ['PREFER marker', 'PREFER one check-in for agent-job-1795493855725-88; status update.', {}],
    ['MUST marker', 'MUST keep agent-job-1795493855725-88; status update.', {}],
    ['NEVER marker', 'NEVER merge agent-job-1795493855725-88; status update.', {}],
    ['ALWAYS marker', 'ALWAYS keep agent-job-1795493855725-88; status update.', {}],
    ['quoted user statement', 'The user said: “keep only the last check-in” for agent-job-1795493855725-88.', {}],
    ['speaker-labeled user quote', '> Jonathon: “Keep only the last check-in” for agent-job-1795493855725-88.', {}],
    ['missing identity', 'Manager status update: the epic is still in progress.', {}],
    ['non-status note with an identity', 'This design note mentions agent-job-1795493855725-88 and describes a layout constraint.', {}],
  ])('returns null for %s', (_label, text, overrides) => {
    // risk: human intent or an unrelated observation must not be superseded
    expect(identity(text, overrides)).toBeNull();
  });
});
