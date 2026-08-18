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

  it('prospects for verified work instead of idling when the board runs dry', () => {
    expect(heartbeatPrompt).toContain('## The Prospector');
    expect(heartbeatPrompt).toContain('empty or fully gated board is not permission to idle');
    expect(heartbeatPrompt).toContain('Goal gap-mining');
    expect(heartbeatPrompt).toContain('QA prospecting');
    expect(heartbeatPrompt).toContain('Friction mining');
    expect(heartbeatPrompt).toContain('Debt and drift sweeps');
    expect(heartbeatPrompt).toContain('De-risk gated lanes');
    expect(heartbeatPrompt).toContain('Prospecting is **create-and-do**, never create-only');
    expect(heartbeatPrompt).toContain('concrete evidence you verified');
  });
});
