// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// Observation memory and identity observations are removed. The real tool registry, the real
// pre-turn recall middleware and the real post-turn writer entry run here. Postgres is a recording
// fake, the v7 subject-memory lookup and the v7 writer scheduler are the faked boundaries.
import '../../Support/TestHomeEnv';

import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as subconscious from '../../../middleware/SubconsciousMiddleware';
import { v7MemoryScheduler } from '../../../memory/V7MemoryAgents';
import { BaseNode } from '../../../nodes/BaseNode';
import { toolRegistry } from '../../../tools/registry';
import { MemorySyncV1 } from '../../../../main/cloud/memorySyncV1';

import type { BaseThreadState, NodeResult } from '../../../nodes/Graph';

/** Records every SQL statement and reports the ones that touch an observation table. */
class RecordingPostgres {
  readonly statements: string[] = [];
  async query(sql: string): Promise<unknown[]> { this.statements.push(String(sql)); return [] }
  async queryOne(sql: string): Promise<null> { this.statements.push(String(sql)); return null }
  async queryAll(sql: string): Promise<unknown[]> { this.statements.push(String(sql)); return [] }
  async queryWithResult(sql: string): Promise<{ rows: unknown[]; rowCount: number }> { this.statements.push(String(sql)); return { rows: [], rowCount: 0 } }
  observationStatements(): string[] {
    return this.statements.filter(sql => /\b(?:identity_)?observations\b/i.test(sql));
  }
}

const f = vi.hoisted(() => ({ db: null as any, recallCalls: 0 }));

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));
vi.mock('@pkg/agent/database/PostgresClient', () => ({
  postgresClient: {
    query:    (sql: string) => f.db.query(sql),
    queryOne: (sql: string) => f.db.queryOne(sql),
    queryAll: (sql: string) => f.db.queryAll(sql),
    queryWithResult: (sql: string) => f.db.queryWithResult(sql),
  },
}));
vi.mock('@pkg/agent/memory/V7SubjectMemory', () => ({
  recallV7SubjectMemory: async() => { f.recallCalls++; return { text: BRAIN_PAGE, stats: { sections: { human: BRAIN_PAGE.length } } } },
}));

const BRAIN_PAGE = '## human.md\n- **DO** Keep the project moving.';
const REMOVED_TOOLS = [
  'add_observational_memory', 'remove_observational_memory', 'search_observations', 'list_observations',
  'add_identity_observation', 'remove_identity_observation', 'search_identity_observations',
  'list_identity_observations', 'update_identity_section',
];
const REPO_ROOT = resolve(__dirname, '../../../../../..');

class ContextProbe extends BaseNode {
  constructor() { super('observation-removal-context', 'Observation removal context') }
  async execute(state: BaseThreadState): Promise<NodeResult<BaseThreadState>> { return { state, decision: { type: 'end' } } as any }
  injected(state: BaseThreadState): string {
    this.injectSubconsciousAssistantContext(state);
    return state.messages.filter((message: any) => message.metadata?.source === 'subconscious_context')
      .map((message: any) => String(message.content)).join('\n');
  }
}

function completedTurn(): BaseThreadState {
  return {
    metadata: { threadId: 'observation-removal-turn', turnId: 'turn-1' },
    messages: [
      { role: 'user', content: 'Remember that I prefer short updates.' },
      { role: 'assistant', content: 'Noted.' },
    ],
  } as unknown as BaseThreadState;
}

beforeEach(() => {
  f.db = new RecordingPostgres();
  f.recallCalls = 0;
});
afterEach(() => { vi.restoreAllMocks() });

describe('tool catalog after observation memory removal', () => {
  it('registers none of the observation or identity-observation tools and still offers v7 memory tools', () => {
    // risk: an agent is still offered a tool that reads or writes a removed memory system
    const names = toolRegistry.getToolNames();

    for (const tool of REMOVED_TOOLS) {
      expect(toolRegistry.isRegistered(tool), tool).toBe(false);
      expect(names, tool).not.toContain(tool);
      expect(toolRegistry.resolveRegisteredName('observation', tool), tool).toBeUndefined();
      expect(toolRegistry.resolveRegisteredName('meta', tool), tool).toBeUndefined();
    }
    expect(names.filter(name => /observational|identity_observation|_observations$/.test(name))).toEqual([]);
    expect(names).toEqual(expect.arrayContaining(['episodic_recall', 'episodic_search', 'recall_conversations']));
  });

  it('places none of the removed tools in the shipped tool placement files', () => {
    // risk: the container tool service keeps routing a removed command from a stale placement file
    const placements = [
      'resources/tool-placements.json',
      'pkg/sulla-desktop/agent/tools/tool-placement-policy.json',
    ].map(file => readFileSync(resolve(REPO_ROOT, file), 'utf8'));

    for (const text of placements) {
      expect(text.length).toBeGreaterThan(100);
      for (const tool of REMOVED_TOOLS) expect(text, tool).not.toContain(`"${ tool }"`);
    }
  });
});

describe('post-turn memory after observation memory removal', () => {
  it('schedules only the v7 writer and writes neither observation table', () => {
    // risk: a background writer keeps adding rows to a memory system the human removed
    const submit = vi.spyOn(v7MemoryScheduler, 'submit').mockImplementation(() => undefined as any);

    subconscious.runV7MemoryWriter(completedTurn(), { includeObservations: true });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toBe('observation-removal-turn');
    expect(f.db.statements).toEqual([]);
    expect(Object.keys(subconscious).filter(name => /observation/i.test(name) && name !== 'runSubconsciousMiddleware')).toEqual([]);
  });
});

describe('cloud memory sync after observation memory removal', () => {
  it('ignores pulled records and tombstones for both retained legacy tables', async() => {
    // risk: a background sync path keeps writing or archiving rows in the removed systems
    const sync = MemorySyncV1 as any;

    await sync.apply({ table: 'observations', id: 'observations:old', generation: 1, value: { id: 'old' } });
    await sync.apply({ table: 'identity_observations', id: 'identity_observations:old', generation: 1, value: { id: 'old' } });
    await sync.tombstone('observations:old');
    await sync.tombstone('identity_observations:old');

    expect(f.db.observationStatements()).toEqual([]);
    expect(f.db.statements).toEqual([]);
  });
});

describe('memory recall after identity observation removal', () => {
  it('recalls v7 subject memory into brain_memory without reading any observation table', async() => {
    // risk: recall breaks, or silently keeps reading identity observations into the prompt
    const state = completedTurn();
    state.messages = [{ role: 'user', content: 'What did we decide about updates?' }] as any;
    (state.metadata as any).agentId = 'conversationalist';
    (state.metadata as any).inputSource = 'voice';

    await subconscious.runSubconsciousMiddleware(state, { includeObservations: true });
    const metadata = state.metadata as any;

    expect(f.recallCalls).toBe(1);
    expect(metadata.brainMemoryContext).toBe(BRAIN_PAGE);
    expect(Object.keys(metadata).filter(key => /observation|humanIdentity/i.test(key))).toEqual([]);
    expect(f.db.observationStatements()).toEqual([]);
    expect(new ContextProbe().injected(state)).toBe(`<brain_memory>\n${ BRAIN_PAGE }\n</brain_memory>`);
  });
});
