import { describe, expect, it } from '@jest/globals';

import { BASE_DISALLOWED_TOOLS } from '../claudeToolPolicy';
import { CODEX_NATIVE_SPAWN_FEATURE_PINS } from '../codexSandboxPolicy';

/**
 * zj21 — provider-native sub-agent spawning is structurally disallowed on
 * every graph-provisioned CLI session. Natively spawned sub-agents report
 * completion to the parent CLI process, not the Sulla graph, so their
 * finished work is silently lost when the process exits. Delegation goes
 * through `sulla agents/spawn_agent` instead (durable parent-graph wake).
 */
describe('native sub-agent spawn lockdown', () => {
  it('disallows Claude Code native spawn tools (Task + Agent rename) on every spawn', () => {
    const disallowed = BASE_DISALLOWED_TOOLS.split(' ');

    expect(disallowed).toContain('Task');
    expect(disallowed).toContain('Agent');
  });

  it('keeps the base non-spawn denylist intact (todo list + AskUserQuestion)', () => {
    const disallowed = BASE_DISALLOWED_TOOLS.split(' ');

    for (const tool of ['AskUserQuestion', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite', 'TodoRead']) {
      expect(disallowed).toContain(tool);
    }
    // Background-process controls are NOT the to-do list and stay enabled.
    expect(disallowed).not.toContain('TaskOutput');
    expect(disallowed).not.toContain('TaskStop');
  });

  it('pins codex multi-agent features off so user config cannot re-enable them', () => {
    expect(CODEX_NATIVE_SPAWN_FEATURE_PINS).toContain('features.multi_agent=false');
    expect(CODEX_NATIVE_SPAWN_FEATURE_PINS).toContain('features.multi_agent_v2=false');
    // Every pin must be an explicit `key=false` — a pin that enables anything
    // does not belong in a lockdown list.
    for (const pin of CODEX_NATIVE_SPAWN_FEATURE_PINS) {
      expect(pin).toMatch(/^features\.[a-z0-9_]+=false$/);
    }
  });
});
