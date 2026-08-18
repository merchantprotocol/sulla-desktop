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

  it('carries task-type execution playbooks that select a checklist without capping items per wake', () => {
    expect(heartbeatPrompt).toContain('## Task-Type Playbooks');
    // Every playbook type is present.
    for (const type of [
      'VERIFY / QA',
      'ROOT-CAUSE',
      'IMPLEMENT / CODE + PR',
      'E2E / ACCEPTANCE',
      'CLEANUP / CURATE',
      'DECISION / GATED',
    ]) {
      expect(heartbeatPrompt).toContain(type);
    }
    // The playbook picks HOW to execute, never how many — it must not reintroduce a one-item cap.
    expect(heartbeatPrompt).toContain('does **not** cap');
    expect(heartbeatPrompt).toContain('never a stop signal');
    // Gated/decision work parks and moves on rather than ending the wake.
    expect(heartbeatPrompt).toContain('Parking one decision never ends the wake');
    // The one-per-cycle throttle removed in #587 must stay gone from the prompt.
    for (const banned of [
      'pick exactly one',
      'make one move',
      'one item per cycle',
      'Cycle Budget',
    ]) {
      expect(heartbeatPrompt).not.toContain(banned);
    }
  });
});
