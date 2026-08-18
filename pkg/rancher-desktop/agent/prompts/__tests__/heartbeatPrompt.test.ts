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

  describe('The Prospector doctrine', () => {
    it('creates proactive work when the board runs dry without reintroducing one-item caps', () => {
      expect(heartbeatPrompt).toMatch(/Prospector/i);
      expect(heartbeatPrompt).toMatch(/create-and-do/i);
      expect(heartbeatPrompt).toMatch(/goal gap-mining/i);
      expect(heartbeatPrompt).toMatch(/QA prospecting/i);
      expect(heartbeatPrompt).toMatch(/friction mining/i);
      expect(heartbeatPrompt).toMatch(/Debt & drift sweep/i);
      expect(heartbeatPrompt).toMatch(/DECISION-type parked proposal/i);

      expect(heartbeatPrompt).not.toMatch(/pick[- ]one/i);
      expect(heartbeatPrompt).not.toMatch(/one[- ]move/i);
      expect(heartbeatPrompt).not.toMatch(/\b(?:do|ship|handle|take)\s+one\s+item\s+per\s+wake\b/i);
      expect(heartbeatPrompt).not.toMatch(/Cycle Budget/i);
      expect(heartbeatPrompt).not.toMatch(/\bSTOP\b/);
    });
  });
});
