import { describe, expect, it } from '@jest/globals';

import {
  BASE_DISALLOWED_TOOLS,
  SUBCONSCIOUS_NATIVE_TOOL_DENYLIST,
  disallowedToolsFor,
  isObserverSpawn,
} from '../claudeToolPolicy';

const tools = (s: string) => new Set(s.split(' ').filter(Boolean));

describe('isObserverSpawn', () => {
  it('locks down subconscious observers', () => {
    expect(isObserverSpawn({ isSubAgent: true, modelSlot: 'subconscious' })).toBe(true);
  });

  it('keeps native actor tools for workflow-node agents stamped primary', () => {
    // PlaybookController sets isSubAgent + modelSlot 'primary' on every
    // workflow agent node; they must keep Bash/Read to run the sulla CLI.
    expect(isObserverSpawn({ isSubAgent: true, modelSlot: 'primary' })).toBe(false);
  });

  it('treats unmarked sub-agents as observers (legacy fail-closed)', () => {
    expect(isObserverSpawn({ isSubAgent: true })).toBe(true);
  });

  it('never locks down the primary chat', () => {
    expect(isObserverSpawn({})).toBe(false);
    expect(isObserverSpawn(undefined)).toBe(false);
  });
});

describe('disallowedToolsFor', () => {
  it('gives the primary chat only the base set, so it keeps Monitor/ScheduleWakeup', () => {
    expect(disallowedToolsFor({})).toBe(BASE_DISALLOWED_TOOLS);
    expect(disallowedToolsFor(undefined)).toBe(BASE_DISALLOWED_TOOLS);
  });

  it('gives workers, reviewers and workflow nodes exactly the primary set', () => {
    expect(disallowedToolsFor({ isSubAgent: true, modelSlot: 'primary' })).toBe(BASE_DISALLOWED_TOOLS);
    const d = tools(disallowedToolsFor({ isSubAgent: true, modelSlot: 'primary' }));
    for (const t of ['Monitor', 'ScheduleWakeup', 'CronCreate', 'RemoteTrigger', 'Workflow', 'Bash', 'Read', 'Edit']) expect(d.has(t)).toBe(false);
  });

  it('strips actor tools from observers', () => {
    const d = tools(disallowedToolsFor({ isSubAgent: true, modelSlot: 'subconscious' }));
    for (const t of tools(BASE_DISALLOWED_TOOLS)) expect(d.has(t)).toBe(true);
    for (const t of tools(SUBCONSCIOUS_NATIVE_TOOL_DENYLIST)) expect(d.has(t)).toBe(true);
  });
});
