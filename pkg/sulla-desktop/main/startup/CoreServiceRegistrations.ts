// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { ServiceLifecycleManager } from '@pkg/agent/services/ServiceLifecycleManager';
import { getBackendGraphWebSocketService } from '@pkg/agent/services/BackendGraphWebSocketService';
import { postgresClient } from '@pkg/agent/database/PostgresClient';
import { redisClient } from '@pkg/agent/database/RedisClient';
import { getDatabaseManager } from '@pkg/agent/database/DatabaseManager';
import Logging from '@pkg/utils/logging';

import { AppStartupTelemetry } from './AppStartupTelemetry';
import type { LifecycleRegistrationProvider } from './LifecycleRegistrationProvider';

const console = Logging.sulla;

/** Independent services, connection readiness gates and the database layer. */
export class CoreServiceRegistrations implements LifecycleRegistrationProvider {
  readonly name = 'core';

  register(lifecycle: ServiceLifecycleManager): void {
    // ── Independent services (no DB/Redis dependency) ──────────────────────

    lifecycle.registerOnce('backend-ws', [],
      async() => {
        getBackendGraphWebSocketService();
        console.log('[Background] BackendGraphWebSocketService initialized');
      },
      async() => { /* stateless singleton, no teardown */ },
    );

    lifecycle.registerOnce('relay-tool-tunnel', [],
      async() => {
        const { startRelayToolTunnel } = await import('@pkg/main/relayToolTunnel');

        startRelayToolTunnel();
      },
      async() => {
        const { stopRelayToolTunnel } = await import('@pkg/main/relayToolTunnel');

        stopRelayToolTunnel();
      },
    );

    // Register model-provider IPC handlers early so the UI can query state
    // even if Postgres/Redis never come up. State loading still gated on DB below.
    lifecycle.registerOnce('model-provider-ipc', [],
      async() => {
        const { getModelProviderService } = await import('@pkg/agent/services/ModelProviderService');
        getModelProviderService().registerIpc();
        console.log('[Background] ModelProviderService IPC handlers registered');
      },
      async() => { /* no teardown */ },
    );

    // ── Connection readiness gates ─────────────────────────────────────────

    lifecycle.registerOnce('postgres', [],
      async() => { await postgresClient.waitForReady(undefined, undefined, (status, attempt, retrying, errorType) => AppStartupTelemetry.emit('postgres-readiness-attempt', status, 'main-process', { attempt, ...(retrying === undefined ? {} : { retrying }), ...(errorType ? { errorType } : {}) })) },
      async() => { await postgresClient.end() },
      { persistOnRestart: true },
    );

    lifecycle.registerOnce('redis', [],
      async() => { await redisClient.waitForReady(undefined, undefined, (status, attempt, retrying, errorType) => AppStartupTelemetry.emit('redis-readiness-attempt', status, 'main-process', { attempt, ...(retrying === undefined ? {} : { retrying }), ...(errorType ? { errorType } : {}) })) },
      async() => { await redisClient.close() },
      { persistOnRestart: true },
    );

    // ── Database layer (depends on postgres connection) ────────────────────

    lifecycle.registerOnce('database-manager', ['postgres', 'redis'],
      async() => { await this.initializeDatabase() },
      async() => { await getDatabaseManager().stop() },
    );
  }

  async initializeDatabase(): Promise<void> {
    // Then initialize database manager
    const dbManager = getDatabaseManager();
    await dbManager.initialize().catch((err: any) => {
      // Make database initialization errors quieter during startup
      if (err.message?.includes('Postgres not connected')) {
        console.debug('[Background] Database not ready yet (PostgreSQL not available)');
      } else {
        console.error('[Background] DatabaseManager failed to initialize:', err);
      }
    });
  }
}
