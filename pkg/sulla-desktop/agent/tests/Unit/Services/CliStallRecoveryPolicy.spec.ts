// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { CliStallRecoveryPolicy } from '../../../languagemodels/CliStallRecoveryPolicy';

describe('CLI stall recovery safety for Codex and Claude Code', () => {
  const policy = new CliStallRecoveryPolicy();

  it('allows retry of a silent Codex session when no tool can have side effects in flight', () => {
    // risk: a safe same-session resume is suppressed after an ordinary transport stall.
    expect(policy.createFault('Codex stalled: no output for 3 minutes', 0, false)).toMatchObject({
      kind: 'stall', retrySafe: true, unsafeToFallback: false,
    });
  });

  it('allows retry of a 15-minute Claude stall only when no tool is unresolved', () => {
    // risk: retrying a Claude turn with an unresolved tool could duplicate a side effect.
    expect(policy.createFault('Claude Code stalled after 15 minutes', 0, false)).toMatchObject({
      kind: 'stall', retrySafe: true, unsafeToFallback: false,
    });
    expect(policy.createFault('Claude Code stalled after 15 minutes', 1, false)).toMatchObject({
      kind: 'stall', retrySafe: false, unsafeToFallback: true,
      message: 'Claude Code stalled after 15 minutes. Recovery was not attempted because a tool was still unresolved.',
    });
    expect(policy.createFault('Claude Code stalled after 15 minutes', 0, true)).toMatchObject({
      kind: 'stall', retrySafe: false, unsafeToFallback: true,
    });
  });
});
