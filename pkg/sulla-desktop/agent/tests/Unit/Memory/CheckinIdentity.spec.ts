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
    expect(identity('Sub-agent result from spawn-agent-memory-cap-worker completed.', { conversationId: 'thread_main' }))
      .toBe('conversation:thread_main:thread:spawn-agent-memory-cap-worker');
  });

  it('keeps two same-template jobs in one conversation separate by job id', () => {
    // risk: different worker jobs in one chat incorrectly supersede each other
    const conversationId = 'thread_spawn_agent_parent';
    const first = identity('Sub-agent result agent-job-1795493855725-88 completed the research task.', { conversationId });
    const second = identity('Sub-agent result agent-job-1795493855725-89 completed the research task.', { conversationId });
    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
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
      '#2816 check-in.',
      '#2816 status update.',
      'PR #2816 is blocked.',
      'currently working on PR #2816.',
      'manager status turn for PR #2816.',
      'worker progress report: #2816.',
      'sub-agent result on PR #2816.',
      'orchestrator wake-up mentions #2816.',
      'heartbeat status update for PR #2816.',
      'detailed chat trace in epic #2816.',
      'draft pull request #2816 complete.',
    ];
    const keys = variants.map(text => identity(text, { conversationId: 'thread_chat_2816' }));
    const recognized = keys.filter((key): key is string => key !== null);
    expect(recognized.length).toBeGreaterThanOrEqual(18);
    expect(new Set(recognized).size).toBe(1);
    expect(identity('PR #2817 status update.', { conversationId: 'thread_chat_2816' }))
      .not.toBe(recognized[0]);
  });

  it('requires an epic when PR identity has no conversation context', () => {
    // risk: unrelated issue numbers are mistaken for an epic-wide check-in
    expect(identity('PR #2816 status update.')).toBeNull();
    expect(identity('#2816 status update.')).toBeNull();
    expect(identity('PR #2816 status update for the memory cap epic.')).toBe('pr:2816');
    expect(identity('PR #2816 status update.', { conversationId: 'thread_2816' }))
      .toBe('conversation:thread_2816:pr:2816');
  });

  it('returns null for non-neutral sentiment', () => {
    // risk: corrections, approvals, or frustrations are hidden by check-in superseding
    expect(identity('Worker progress update: agent-job-1795493855725-88.', { sentiment: 'correction' })).toBeNull();
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
