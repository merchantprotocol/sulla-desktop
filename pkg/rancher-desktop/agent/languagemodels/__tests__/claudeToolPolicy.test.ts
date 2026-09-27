import { describe, expect, it } from '@jest/globals';

import {
  BASE_DISALLOWED_TOOLS,
  SUBCONSCIOUS_NATIVE_TOOL_DENYLIST,
  WORKER_DETACHED_WORK_DENYLIST,
  disallowedToolsFor,
  isObserverSpawn,
  isWorkerSpawn,
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

describe('isWorkerSpawn', () => {
  it('is true only for primary-slot sub-agents', () => {
    expect(isWorkerSpawn({ isSubAgent: true, modelSlot: 'primary' })).toBe(true);
    expect(isWorkerSpawn({ isSubAgent: true, modelSlot: 'subconscious' })).toBe(false);
    expect(isWorkerSpawn({ isSubAgent: true })).toBe(false);
    expect(isWorkerSpawn({})).toBe(false);
    expect(isWorkerSpawn(undefined)).toBe(false);
  });
});

describe('disallowedToolsFor', () => {
  it('gives the primary chat only the base set, so it keeps Monitor/ScheduleWakeup', () => {
    expect(disallowedToolsFor({})).toBe(BASE_DISALLOWED_TOOLS);
    expect(disallowedToolsFor(undefined)).toBe(BASE_DISALLOWED_TOOLS);
  });

  it('keeps actor tools for workers but strips detached-work tools', () => {
    const d = tools(disallowedToolsFor({ isSubAgent: true, modelSlot: 'primary' }));
    for (const t of tools(BASE_DISALLOWED_TOOLS)) expect(d.has(t)).toBe(true);
    for (const t of ['Monitor', 'ScheduleWakeup', 'CronCreate', 'RemoteTrigger', 'Workflow']) expect(d.has(t)).toBe(true);
    for (const t of ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebFetch']) expect(d.has(t)).toBe(false);
  });

  it('strips actor tools from observers', () => {
    const d = tools(disallowedToolsFor({ isSubAgent: true, modelSlot: 'subconscious' }));
    for (const t of tools(BASE_DISALLOWED_TOOLS)) expect(d.has(t)).toBe(true);
    for (const t of tools(SUBCONSCIOUS_NATIVE_TOOL_DENYLIST)) expect(d.has(t)).toBe(true);
  });

  it('never denies actor tools through the worker list', () => {
    const worker = tools(WORKER_DETACHED_WORK_DENYLIST);
    for (const t of ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob']) expect(worker.has(t)).toBe(false);
  });
});
