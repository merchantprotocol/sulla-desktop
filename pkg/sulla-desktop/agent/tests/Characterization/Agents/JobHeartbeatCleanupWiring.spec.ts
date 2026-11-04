// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { TestDatabase } from '../../Support/TestDatabase';

// ChatHeartbeatService.ts is the real module under test here — its
// getChatHeartbeatService() is the real composition root this spec exists to
// prove actually subscribes JobHeartbeatCleanup (see JobHeartbeatCleanup.ts
// and ChatHeartbeatService.ts for why). Only its Electron/DOM-touching
// transitive imports are mocked, matching ChatHeartbeatService.spec.ts's
// convention — jobRegistry and AgentJobServiceProvider stay real and
// Postgres-backed, because the one thing worth proving end-to-end is that
// completing a real job reaches the real scheduler, not a test-only listener.
vi.mock('@pkg/agent/services/GraphRegistry', () => ({ GraphRegistry: { get: () => undefined } }));
vi.mock('@pkg/agent/services/AgentJobLifecycleService', () => ({ agentJobLifecycle: { hasLiveWaiter: () => false } }));
vi.mock('@pkg/agent/services/BackendGraphWebSocketService', () => ({ getBackendGraphWebSocketService: () => ({ wakeParkedAgent: async() => false }) }));
vi.mock('@pkg/agent/services/WebSocketClientService', () => ({ getWebSocketClientService: () => ({ send: async() => true }) }));
vi.mock('@pkg/agent/services/AgentDefinitionService', () => ({ agentDefinitionService: { findBySlug: async() => null, get: async() => null } }));
vi.mock('@pkg/main/SleepPreventionService', () => ({ acquireChatActivity: () => undefined, releaseChatActivity: () => undefined }));
vi.mock('@pkg/agent/utils/agentLogger', () => ({ frontendGraphLogger: { warn: () => undefined, log: () => undefined, error: () => undefined, info: () => undefined } }));

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;

dbDescribe('JobHeartbeatCleanup real composition-root wiring (real Postgres)', () => {
  const database = new TestDatabase();
  let registry: typeof import('../../../tools/agents/jobRegistry');
  let scheduler: ReturnType<typeof import('../../../services/ChatHeartbeatService')['getChatHeartbeatService']>;

  beforeAll(async() => {
    await database.initialize();
    process.env.SULLA_DATABASE_URL = database.appUrl();
    process.env.PGOPTIONS = `-csearch_path=${ database.schema },public`;
    process.env.SULLA_DATABASE_POOL_MAX = '1';
    const { postgresClient } = await import('../../../database/PostgresClient');
    await postgresClient.initialize();
    await postgresClient.query(`SET search_path TO "${ database.schema }", public`);
    registry = await import('../../../tools/agents/jobRegistry');
    const { getChatHeartbeatService } = await import('../../../services/ChatHeartbeatService');
    scheduler = getChatHeartbeatService();
  }, 60_000);
  afterAll(async() => database.dispose());
  afterEach(() => { scheduler.unregister('thread-cleanup-wiring') });

  it('unregisters a hidden job thread heartbeat the instant completeJob runs, through the real app wiring', async() => {
    // risk: JobHeartbeatCleanup.ts's module-load subscribe looked wired but nothing
    // production ever imported that module, so cleanup silently never ran (A-1b) —
    // this exercises getChatHeartbeatService(), the actual production entry point,
    // instead of a fake listener subscribed directly by the test.
    const threadId = 'thread-cleanup-wiring';
    const job = await registry.createJob([{ agentId: 'worker', label: 'w', prompt: 'x', status: 'running', threadId }]);
    scheduler.register({ threadId, channel: 'sulla-desktop', config: { intervalMinutes: 5, message: 'beat' }, busy: false });
    expect(scheduler.status(threadId)).not.toBeNull();

    await registry.completeJob(job.jobId, [{ label: 'w', status: 'completed', output: 'done', threadId }]);

    expect(scheduler.status(threadId)).toBeNull();
  });

  it('unregisters a parked job thread heartbeat the instant stopJobCascade runs, through the real app wiring', async() => {
    // risk: cleanup only wired for completeJob's call site, missing abortJob/stopJobCascade entry points
    const threadId = 'thread-cleanup-wiring';
    const job = await registry.createJob([{ agentId: 'worker', label: 'w', prompt: 'x', status: 'running', threadId }]);
    scheduler.register({ threadId, channel: 'sulla-desktop', config: { intervalMinutes: 5, message: 'beat' }, busy: false });
    expect(scheduler.status(threadId)).not.toBeNull();

    await registry.stopJobCascade(job.jobId);

    expect(scheduler.status(threadId)).toBeNull();
  });
});
