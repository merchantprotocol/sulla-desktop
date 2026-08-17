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

  it('enforces the one-move cycle budget, escalation ladder, and anti-noise rule', () => {
    // Cycle budget: pick one task, make one concrete move, verify, bookkeep, stop.
    expect(heartbeatPrompt).toContain('## Cycle Budget & Escalation');
    expect(heartbeatPrompt).toContain('Pick ONE task');
    expect(heartbeatPrompt).toContain('Make ONE concrete, artifact-producing move');
    // Exceed-budget => write the exact next action and resume from the comment, not chat memory.
    expect(heartbeatPrompt).toContain('Exceed budget?');
    expect(heartbeatPrompt).toContain('resume next cycle from that comment');
    // Escalation: reroute before parking; park only irreversible/gated decisions.
    expect(heartbeatPrompt).toContain('Escalation ladder');
    // Anti-noise: no status-only comments; advance a different unblocked task instead.
    expect(heartbeatPrompt).toContain('### Anti-Noise Rule');
    expect(heartbeatPrompt).toContain('Never post a status-only comment when nothing changed');
    expect(heartbeatPrompt).toContain('advance a different unblocked task');
    // Resume-from-state digest trailer.
    expect(heartbeatPrompt).toContain('--- HB-DIGEST v1 ---');
  });

  it('boots from the heartbeat lane and retires the markdown state file', () => {
    // The workboard is the only work-state store; HEARTBEAT_STATE.md is dead.
    expect(heartbeatPrompt).toContain('HEARTBEAT_STATE.md');
    expect(heartbeatPrompt).toContain('RETIRED');
    // First action pulls the heartbeat-assigned lane, not a file read.
    expect(heartbeatPrompt).toContain('"assignee":"heartbeat"');
    // Unassigned work is claimed by self-assigning into the lane.
    expect(heartbeatPrompt).toContain('self-assign');
  });
});
