// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Characterization of Sulla's service startup after it moved out of sulla.ts.
// Pins the pre-registration steps, the provider order, and every lifecycle
// registration (name, dependencies, options) exactly as sulla.ts registered
// them, because ServiceLifecycleManager start order and vault/Files gating
// depend on them. risk: startup ordering (vault unlock, Files mount).

import { describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/utils/logging', () => ({ default: { sulla: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } }));
vi.mock('@pkg/agent/services/BackendGraphWebSocketService', () => ({ getBackendGraphWebSocketService: vi.fn() }));
vi.mock('@pkg/agent/database/PostgresClient', () => ({ postgresClient: { waitForReady: vi.fn(), end: vi.fn() } }));
vi.mock('@pkg/agent/database/RedisClient', () => ({ redisClient: { waitForReady: vi.fn(), close: vi.fn() } }));
vi.mock('@pkg/agent/database/DatabaseManager', () => ({ getDatabaseManager: vi.fn() }));
vi.mock('@pkg/agent/services/SchedulerService', () => ({ getSchedulerService: vi.fn() }));
vi.mock('@pkg/agent/services/HeartbeatService', () => ({ getHeartbeatService: vi.fn() }));
vi.mock('@pkg/agent/services/WorkflowSchedulerService', () => ({ getWorkflowSchedulerService: vi.fn() }));
vi.mock('@pkg/agent/services/WorkflowContainerEventBridge', () => ({ getWorkflowContainerEventBridge: vi.fn() }));
vi.mock('@pkg/main/chatCompletionsServer', () => ({ ChatCompletionsServer: { STOP_TIMEOUT_MS: 20_000 }, getChatCompletionsServer: vi.fn() }));
vi.mock('@pkg/main/MCPServerHost', () => ({ getMCPServerHost: vi.fn() }));
vi.mock('@pkg/main/HeadlessBrowserReaper', () => ({ headlessBrowserReaper: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('@pkg/main/sullaFilesWatcher', () => ({
  getSullaFilesWatcher: () => ({ startupStatus: () => ({ ready: false, filesUnlocked: false }) }),
}));
vi.mock('@pkg/agent/integrations', () => ({ SullaIntegrations: vi.fn() }));

import { ApplicationServiceRegistrations } from '../../../../main/startup/ApplicationServiceRegistrations';
import { CoreServiceRegistrations } from '../../../../main/startup/CoreServiceRegistrations';
import { ServiceLifecycleStartup, type ServiceStartupHooks } from '../../../../main/startup/ServiceLifecycleStartup';
import { VaultServiceRegistrations } from '../../../../main/startup/VaultServiceRegistrations';
import type { LifecycleRegistrationProvider } from '../../../../main/startup/LifecycleRegistrationProvider';
import type { VaultStateCoordinator } from '../../../../main/startup/VaultStateCoordinator';

interface Registration { name: string; deps: string[]; opts?: Record<string, unknown> }

class RecordingLifecycle {
  readonly registrations: Registration[] = [];
  readonly calls: string[];
  startAllError: Error | undefined;

  constructor(calls: string[] = []) { this.calls = calls }

  registerOnce(name: string, deps: string[], _start: unknown, _stop: unknown, opts?: Record<string, unknown>): void {
    this.registrations.push({ name, deps, opts });
  }

  async startAll(assertCurrent?: () => void): Promise<void> {
    this.calls.push(`startAll:${ assertCurrent ? 'guarded' : 'plain' }`);
    if (this.startAllError) throw this.startAllError;
  }
}

class RecordingHooks implements ServiceStartupHooks {
  constructor(private readonly calls: string[], private readonly lifecycleValue: RecordingLifecycle) {}
  async configureSignedInVaultBroker(): Promise<void> { this.calls.push('configureSignedInVaultBroker') }
  async bootstrapSullaHome(): Promise<void> { this.calls.push('bootstrapSullaHome') }
  lifecycle(): any { this.calls.push('lifecycle'); return this.lifecycleValue }
}

class RecordingProvider implements LifecycleRegistrationProvider {
  constructor(readonly name: string, private readonly calls: string[]) {}
  register(): void { this.calls.push(`register:${ this.name }`) }
}

const fakeVaultState = {} as VaultStateCoordinator;

// The registrations exactly as sulla.ts made them before the move (name and dependencies, in order).
const EXPECTED: [string, string[]][] = [
  ['backend-ws', []],
  ['relay-tool-tunnel', []],
  ['model-provider-ipc', []],
  ['postgres', []],
  ['redis', []],
  ['database-manager', ['postgres', 'redis']],
  ['scheduler', ['database-manager']],
  ['heartbeat', ['database-manager', 'redis']],
  ['sulla-files-maintenance', ['database-manager']],
  ['database-retention', ['database-manager']],
  ['workflow-recovery', ['database-manager']],
  ['workflow-scheduler', ['database-manager']],
  ['workflow-container-events', ['database-manager', 'redis']],
  ['chat-server', ['database-manager']],
  ['local-tool-tunnel', ['chat-server', 'vault']],
  ['mcp-server-host', []],
  ['headless-browser-reaper', []],
  ['accounts', []],
  ['vault', ['database-manager']],
  ['sulla-files-runtime', ['vault']],
  ['model-provider', ['database-manager', 'redis']],
  ['integrations', ['vault']],
  ['oauth', ['database-manager', 'vault']],
  ['file-search', []],
  ['host-access-sync', ['database-manager', 'redis']],
];

function productionProviders(): LifecycleRegistrationProvider[] {
  return [new CoreServiceRegistrations(), new ApplicationServiceRegistrations(), new VaultServiceRegistrations(fakeVaultState)];
}

describe('ServiceLifecycleStartup', () => {
  it('configures the broker, bootstraps home, registers providers in order, then starts', async() => {
    const calls: string[] = [];
    const lifecycle = new RecordingLifecycle(calls);
    const startup = new ServiceLifecycleStartup(new RecordingHooks(calls, lifecycle), [
      new RecordingProvider('core', calls), new RecordingProvider('application', calls), new RecordingProvider('vault', calls),
    ]);

    await startup.start(() => undefined);

    expect(calls).toEqual([
      'configureSignedInVaultBroker', 'bootstrapSullaHome', 'lifecycle',
      'register:core', 'register:application', 'register:vault', 'startAll:guarded',
    ]);
  });

  it('logs and swallows a startAll failure on an unguarded boot', async() => {
    const lifecycle = new RecordingLifecycle();
    lifecycle.startAllError = new Error('postgres never came up');
    const startup = new ServiceLifecycleStartup(new RecordingHooks([], lifecycle), []);

    await expect(startup.start()).resolves.toBeUndefined();
  });

  it('rethrows a startAll failure when the backend generation guard is supplied', async() => {
    const lifecycle = new RecordingLifecycle();
    lifecycle.startAllError = new Error('stale generation');
    const startup = new ServiceLifecycleStartup(new RecordingHooks([], lifecycle), []);

    await expect(startup.start(() => undefined)).rejects.toThrow('stale generation');
  });

  it('does not register anything when bootstrapping the home folder fails', async() => {
    const calls: string[] = [];
    const lifecycle = new RecordingLifecycle(calls);
    const hooks = new RecordingHooks(calls, lifecycle);
    hooks.bootstrapSullaHome = async() => { throw new Error('home not writable') };
    const startup = new ServiceLifecycleStartup(hooks, [new RecordingProvider('core', calls)]);

    await expect(startup.start()).rejects.toThrow('home not writable');
    expect(calls).toEqual(['configureSignedInVaultBroker']);
  });
});

describe('production lifecycle registrations', () => {
  it('registers every service with the same names, dependencies and order as sulla.ts did', () => {
    const lifecycle = new RecordingLifecycle();

    for (const provider of productionProviders()) provider.register(lifecycle as any);

    expect(lifecycle.registrations.map(r => [r.name, r.deps])).toEqual(EXPECTED);
  });

  it('keeps the vault gating, restart persistence and stop budget options', () => {
    const lifecycle = new RecordingLifecycle();

    for (const provider of productionProviders()) provider.register(lifecycle as any);
    const opts = Object.fromEntries(lifecycle.registrations.map(r => [r.name, r.opts]));

    expect(opts.postgres).toEqual({ persistOnRestart: true });
    expect(opts.redis).toEqual({ persistOnRestart: true });
    expect(opts['chat-server']).toEqual({ stopTimeoutMs: 20_000 });
    for (const name of ['local-tool-tunnel', 'sulla-files-runtime', 'model-provider', 'integrations', 'oauth']) {
      expect(opts[name]?.requiresVault).toBe(true);
    }
    for (const name of ['vault', 'database-manager', 'accounts', 'file-search', 'host-access-sync']) {
      expect(opts[name]?.requiresVault).toBeUndefined();
    }
    // The tool tunnel waits on Files readiness and explains why it is waiting.
    const tunnel = opts['local-tool-tunnel'] as { readiness: () => boolean; readinessReason: () => string };
    expect(tunnel.readiness()).toBe(false);
    expect(tunnel.readinessReason()).toBe('Files is not unlocked');
  });
});
