import { describe, expect, it } from '@jest/globals';

import { heartbeatPrompt } from '../heartbeat';

describe('heartbeatPrompt', () => {
  it('keeps the autonomous loop anchored to the bundled docs and live tool catalog', () => {
    expect(heartbeatPrompt).toContain('## Docs + Tool Catalog Boot');
    expect(heartbeatPrompt).toContain('sulla-docs/INDEX.md');
    expect(heartbeatPrompt).toContain('tools/inventory.md');
    expect(heartbeatPrompt).toContain('agent-patterns/known-gaps.md');
    expect(heartbeatPrompt).toContain('Never guess Sulla CLI tool names');
    expect(heartbeatPrompt).toContain('browse_tools');
    expect(heartbeatPrompt).toContain('exec');
    expect(heartbeatPrompt).toContain('sulla <category>/<tool>');
  });

  it('boots from the heartbeat lane and retires the markdown state file', () => {
    // Projects is the only project-state store; HEARTBEAT_STATE.md is dead.
    expect(heartbeatPrompt).toContain('HEARTBEAT_STATE.md');
    expect(heartbeatPrompt).toContain('RETIRED');
    // First action pulls the heartbeat-assigned lane, not a file read.
    expect(heartbeatPrompt).toContain('"assignee":"heartbeat"');
    // Unassigned work is claimed by self-assigning into the lane.
    expect(heartbeatPrompt).toContain('self-assign');
  });

  // Regression guard for #587: Jonathon rejected the "pick one task, make one
  // move, STOP" cycle ceiling (#581) and required a continuous operator that
  // works the whole portfolio per wake. PR #581 proved this framing can be
  // reintroduced, so pin the corrected language and forbid the rejected phrasing.
  it('frames heartbeat as a continuous operator, not a one-task-per-cycle worker', () => {
    // Positive: the continuous-operator guarantee must be present.
    expect(heartbeatPrompt).toContain('not a one-task worker');
    expect(heartbeatPrompt).toContain('does not cap you at one item per wake');
    expect(heartbeatPrompt).toContain('Never end a wake idle');

    // Negative: the rejected pick-one / one-move / STOP ceiling must not return.
    // Matchers are tuned to #581's signature ("Cycle Budget" section header,
    // "pick exactly ONE task", "make ONE ... move", "one item per cycle") and
    // deliberately do NOT trip on legit language kept in the prompt: "pick the
    // top open task", "One task per decision", "does not cap you at one item per wake".
    expect(heartbeatPrompt).not.toContain('Cycle Budget');
    expect(heartbeatPrompt).not.toMatch(/pick exactly one/i);
    expect(heartbeatPrompt).not.toMatch(/make one\b[^.]*\bmove/i);
    expect(heartbeatPrompt).not.toMatch(/one[- ]move budget/i);
    expect(heartbeatPrompt).not.toMatch(/one item per cycle/i);
  });
});
