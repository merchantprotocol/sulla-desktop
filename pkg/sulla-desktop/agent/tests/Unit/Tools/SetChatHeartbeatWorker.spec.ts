// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDefinition } from '../../../database/models/AgentDefinitionModel';
import { AgentHeartbeatPolicy, type AgentDefinitionLookup } from '../../../services/AgentHeartbeatPolicy';
import { ChatHeartbeatScheduler } from '../../../services/ChatHeartbeatScheduler';
import { SetChatHeartbeatWorker } from '../../../tools/chat/set_heartbeat';
import type { ToolResponse } from '../../../tools/base';

// set_heartbeat.ts imports ChatHeartbeatService for its constructor's default
// scheduler factory, which transitively pulls in GraphRegistry's full tool
// registry (many of those tools import Electron eagerly). Every fixture here
// injects its own scheduler explicitly, so the real factory is never called —
// mock the module instead of letting its import graph load outside Electron.
vi.mock('@pkg/agent/services/ChatHeartbeatService', () => ({
  getChatHeartbeatService: () => { throw new Error('getChatHeartbeatService() must not be called when a scheduler is injected') },
}));

const heartbeat = (allowed: boolean) => ({ allowed, defaultIntervalMinutes: 5, minIntervalMinutes: 2, maxIntervalMinutes: 10 });
const definition = (slug: string, config: Record<string, unknown>): AgentDefinition => ({
  id: `${ slug }-id`, slug, config,
} as AgentDefinition);

class InMemoryAgentDefinitionRepository implements AgentDefinitionLookup {
  constructor(private readonly rows: Map<string, AgentDefinition>) {}

  set(slug: string, row: AgentDefinition): void { this.rows.set(slug, row); }
  async get(id: string): Promise<AgentDefinition | null> {
    return [...this.rows.values()].find(row => row.id === id) ?? null;
  }
  async findBySlug(slug: string): Promise<AgentDefinition | null> { return this.rows.get(slug) ?? null; }
}

class SetChatHeartbeatHarness extends SetChatHeartbeatWorker {
  setAgentState(agentId: string, threadId: string): void {
    this.setState({ metadata: { agentId, wsChannel: 'agent-channel', threadId } });
  }

  execute(input: Record<string, unknown>): Promise<ToolResponse> { return this._validatedCall(input); }
}

class WorkerFixture {
  readonly repository = new InMemoryAgentDefinitionRepository(new Map());
  readonly scheduler = new ChatHeartbeatScheduler({
    isGraphBusy: () => false,
    deliver:     async() => true,
  });
  readonly worker = new SetChatHeartbeatHarness(new AgentHeartbeatPolicy(this.repository), this.scheduler);
  readonly threads = new Set<string>();

  async call(agentId: string, intervalMinutes: number, threadId = `${ agentId }-thread`): Promise<ToolResponse> {
    this.threads.add(threadId);
    this.worker.setAgentState(agentId, threadId);
    return this.worker.execute({ intervalMinutes });
  }

  dispose(): void { for (const threadId of this.threads) this.scheduler.unregister(threadId); }
}

let fixture: WorkerFixture;
afterEach(() => fixture?.dispose());

describe('SetChatHeartbeatWorker policy integration', () => {
  it('refuses a denied worker before registering or configuring the scheduler', async() => {
    // risk: worker bypasses agent-definition governance and creates a background wakeup
    fixture = new WorkerFixture();
    fixture.repository.set('worker', definition('worker', { heartbeat: heartbeat(false) }));

    const result = await fixture.call('worker', 5);

    expect(result).toEqual({
      successBoolean: false,
      responseString: expect.stringContaining('config.heartbeat.allowed'),
    });
    expect(fixture.scheduler.status('worker-thread')).toBeNull();
  });

  it('configures an allowed lead at the requested interval', async() => {
    // risk: a valid manager cannot keep its hidden background chat awake
    fixture = new WorkerFixture();
    fixture.repository.set('lead', definition('lead', { heartbeat: heartbeat(true) }));

    await expect(fixture.call('lead', 7)).resolves.toMatchObject({ successBoolean: true });
    expect(fixture.scheduler.status('lead-thread')).toMatchObject({ enabled: true, intervalMinutes: 7 });
  });

  it('refuses rather than clamps an interval outside the configured range', async() => {
    // risk: scheduler silently runs at an interval the agent definition did not authorize
    fixture = new WorkerFixture();
    fixture.repository.set('lead', definition('lead', { heartbeat: heartbeat(true) }));

    const result = await fixture.call('lead', 11);

    expect(result).toMatchObject({ successBoolean: false, responseString: expect.stringContaining('between 2 and 10') });
    expect(fixture.scheduler.status('lead-thread')).toBeNull();
  });

  it.each([
    ['denied', { heartbeat: heartbeat(false) }],
    ['malformed', { heartbeat: 'invalid' }],
  ])('always allows interval zero for a %s agent', async(_label, config) => {
    // risk: policy prevents an agent from disabling an existing wakeup
    fixture = new WorkerFixture();
    fixture.repository.set('worker', definition('worker', config));

    await expect(fixture.call('worker', 0)).resolves.toMatchObject({ successBoolean: true });
    expect(fixture.scheduler.status('worker-thread')).toMatchObject({ enabled: false, intervalMinutes: null });
  });

  it.each([
    ['missing', {}],
    ['malformed', { heartbeat: { allowed: true } }],
  ])('refuses %s config and names config.heartbeat', async(_label, config) => {
    // risk: absent or corrupt policy defaults to permission
    fixture = new WorkerFixture();
    fixture.repository.set('worker', definition('worker', config));

    const result = await fixture.call('worker', 5);

    expect(result).toMatchObject({ successBoolean: false, responseString: expect.stringContaining('config.heartbeat') });
    expect(fixture.scheduler.status('worker-thread')).toBeNull();
  });

  it('re-reads the definition so a live allow-to-deny switch blocks the next call', async() => {
    // risk: revoked permission remains cached in a long-lived worker
    fixture = new WorkerFixture();
    fixture.repository.set('lead', definition('lead', { heartbeat: heartbeat(true) }));
    await expect(fixture.call('lead', 5)).resolves.toMatchObject({ successBoolean: true });

    fixture.repository.set('lead', definition('lead', { heartbeat: heartbeat(false) }));
    const result = await fixture.call('lead', 6, 'another-thread');

    expect(result).toMatchObject({ successBoolean: false, responseString: expect.stringContaining('config.heartbeat.allowed') });
    expect(fixture.scheduler.status('another-thread')).toBeNull();
  });
});
