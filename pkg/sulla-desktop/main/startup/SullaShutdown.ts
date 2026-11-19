// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { app } from 'electron';

import { postgresClient } from '@pkg/agent/database/PostgresClient';
import { redisClient } from '@pkg/agent/database/RedisClient';
import { getServiceLifecycleManager } from '@pkg/agent/services/ServiceLifecycleManager';
import Logging from '@pkg/utils/logging';

const console = Logging.sulla;

/**
 * Application shutdown. All service teardown is handled by
 * ServiceLifecycleManager.stopAll(); only SIGTERM/SIGINT are registered here
 * as emergency fallbacks.
 */
export class SullaShutdown {
  hookSignals(): void {
    process.on('SIGTERM', async() => {
      console.log('[Shutdown] SIGTERM received');
      const lifecycle = getServiceLifecycleManager();

      await this.end('full');
      app.quit();
    });
    process.on('SIGINT', async() => {
      console.log('[Shutdown] SIGINT received');
      const lifecycle = getServiceLifecycleManager();

      await this.end('full');
      app.quit();
    });
  }

  async end(mode: 'full' | 'restart' = 'full'): Promise<void> {
    const { drainAgentExecution } = await import('@pkg/agent/services/BackendGraphWebSocketService');
    const { awaitWithBudget } = await import('@pkg/utils/awaitWithBudget');
    await awaitWithBudget('agent execution drain', drainAgentExecution(), 10000);
    const lifecycle = getServiceLifecycleManager();

    // Stop the terminal WebSocket server (kills any live sulla-runtime exec PTYs).
    try {
      const { getTerminalServer } = await import('@pkg/main/terminalServer');

      await getTerminalServer().stop();
    } catch (err) {
      console.warn('[sullaEnd] Terminal server stop failed:', err);
    }

    await lifecycle.stopAll(mode);

    // Force-close connection clients if they're still alive.
    // Lifecycle may think they never started (e.g. slow Docker boot
    // caused waitForReady to fail), but the clients may have connected
    // independently via lazy-init or retry loops.
    if (mode === 'full') {
      if (postgresClient.isConnected()) {
        console.log('[sullaEnd] Postgres still connected after lifecycle — force-closing');
        try { await postgresClient.end() } catch { /* ignore */ }
      }
      if (redisClient.getClient()?.status !== 'end') {
        console.log('[sullaEnd] Redis client still alive after lifecycle — force-closing');
        try { await redisClient.close() } catch { /* ignore */ }
      }
    }
  }
}
