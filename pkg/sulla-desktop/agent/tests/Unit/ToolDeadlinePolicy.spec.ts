// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { ToolDeadlinePolicy } from '../../../../../packages/runtime-protocol/src/toolDeadlinePolicy';
import { LateToolResultStore } from '../../../runtime/LateToolResultStore';

describe('tool deadline policy', () => {
  const policy = new ToolDeadlinePolicy();

  it('returns an explicit unknown-side-effect warning for a timed-out writer', () => {
    // risk: irreversible tool side effects may have completed despite a timeout
    expect(policy.timeoutDetails('create_pr', 120_000, 120_010, ['create'])).toEqual({
      tool: 'create_pr', deadlineMs: 120_000, elapsedMs: 120_010, sideEffectUnknown: true,
      hint: 'check state before retrying, e.g. github/list_prs for create_pr',
    });
  });

  it('gives a read-only timeout a safe single-retry hint', () => {
    // risk: read-only calls are unnecessarily treated as uncertain writes and workers stall
    expect(policy.timeoutDetails('list_prs', 15_000, 15_001, ['read'])).toEqual({
      tool: 'list_prs', deadlineMs: 15_000, elapsedMs: 15_001, hint: 'safe to retry once',
    });
  });

  it('selects short manifest-read defaults and longer network-writer overrides', () => {
    // risk: one global timeout stalls discovery calls or prematurely expires network writes
    expect(policy.deadlineMs('browse_tools', ['read'])).toBe(15_000);
    expect(policy.deadlineMs('git_push', ['update'])).toBe(120_000);
    expect(policy.deadlineMs('custom_write', ['create'])).toBe(120_000);
    expect(policy.deadlineMs('unknown_tool')).toBe(120_000);
    // risk: a read deadline (15 s) would kill the agent mail OTP long-poll (up to 300 s) mid-wait
    expect(policy.deadlineMs('mail_wait_for_code', ['read'])).toBe(305_000);
  });

  it('does not clamp a writer request below its 120 s deadline', () => {
    // risk: Desktop aborted writers at 60 s, so the longer writer deadline never took effect
    expect(policy.requestedDeadlineMs(120_000)).toBe(120_000);
    expect(policy.requestedDeadlineMs(999_999)).toBe(305_000);
    expect(policy.requestedDeadlineMs(undefined)).toBe(30_000);
    expect(policy.requestedDeadlineMs('not-a-number')).toBe(30_000);
    expect(policy.requestedDeadlineMs(0)).toBe(1);
  });

  it('records late completion by request id and evicts it after ten minutes', () => {
    // risk: a timed-out write completes later without a trace, making retry unsafe
    let now = 1_000;
    const store = new LateToolResultStore(() => now);
    store.record('request-1', { success: true, result: { created: true } });
    expect(store.get('request-1')).toMatchObject({ requestId: 'request-1', outcome: 'success', result: { success: true } });
    now += 10 * 60_000;
    expect(store.get('request-1')).toBeUndefined();
  });
});
