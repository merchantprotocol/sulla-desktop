// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { ServiceLifecycleManager } from '@pkg/agent/services/ServiceLifecycleManager';
import { getSchedulerService } from '@pkg/agent/services/SchedulerService';
import { getHeartbeatService } from '@pkg/agent/services/HeartbeatService';
import { getWorkflowSchedulerService } from '@pkg/agent/services/WorkflowSchedulerService';
import { getWorkflowContainerEventBridge } from '@pkg/agent/services/WorkflowContainerEventBridge';
import { ChatCompletionsServer, getChatCompletionsServer } from '@pkg/main/chatCompletionsServer';
import { getMCPServerHost } from '@pkg/main/MCPServerHost';
import { headlessBrowserReaper } from '@pkg/main/HeadlessBrowserReaper';
import { getSullaFilesWatcher } from '@pkg/main/sullaFilesWatcher';
import Logging from '@pkg/utils/logging';

import type { LifecycleRegistrationProvider } from './LifecycleRegistrationProvider';

const console = Logging.sulla;

/** Application services that depend on the database layer, plus the tool tunnels and accounts. */
export class ApplicationServiceRegistrations implements LifecycleRegistrationProvider {
  readonly name = 'application';

  register(lifecycle: ServiceLifecycleManager): void {
    // ── Application services (depend on database-manager) ──────────────────

    lifecycle.registerOnce('scheduler', ['database-manager'],
      async() => {
        await getSchedulerService().initialize();
        console.log('[Background] SchedulerService initialized');
      },
      async() => {
        getSchedulerService().destroy();
        console.log('[Background] SchedulerService destroyed');
      },
    );

    lifecycle.registerOnce('heartbeat', ['database-manager', 'redis'],
      async() => {
        await getHeartbeatService().initialize();
        console.log('[Background] HeartbeatService initialized');
      },
      async() => {
        getHeartbeatService().destroy();
        console.log('[Background] HeartbeatService destroyed');
      },
    );

    lifecycle.registerOnce('sulla-files-maintenance', ['database-manager'],
      async() => {
        const { getSullaFilesMaintenanceService } = await import('@pkg/agent/services/SullaFilesMaintenanceService');
        getSullaFilesMaintenanceService().initialize();
        console.log('[Background] Sulla Files maintenance initialized');
      },
      async() => {
        const { getSullaFilesMaintenanceService } = await import('@pkg/agent/services/SullaFilesMaintenanceService');
        getSullaFilesMaintenanceService().shutdown();
      },
    );

    lifecycle.registerOnce('database-retention', ['database-manager'],
      async() => {
        const { databaseRetentionService } = await import('@pkg/agent/services/DatabaseRetentionService');
        databaseRetentionService.initialize();
        console.log('[Background] Database retention initialized');
      },
      async() => {
        const { databaseRetentionService } = await import('@pkg/agent/services/DatabaseRetentionService');
        databaseRetentionService.shutdown();
      },
    );

    lifecycle.registerOnce('workflow-recovery', ['database-manager'],
      async() => {
        const { workflowRecoveryService } = await import('@pkg/agent/app/Providers/WorkflowRecoveryServiceProvider');
        await workflowRecoveryService.start();
        console.log('[Background] Workflow recovery initialized');
      },
      async() => {
        const { workflowRecoveryService } = await import('@pkg/agent/app/Providers/WorkflowRecoveryServiceProvider');
        await workflowRecoveryService.stop();
      },
    );

    lifecycle.registerOnce('workflow-scheduler', ['database-manager'],
      async() => {
        await getWorkflowSchedulerService().initialize();
        console.log('[Background] WorkflowSchedulerService initialized');
      },
      async() => { getWorkflowSchedulerService().shutdown() },
    );

    lifecycle.registerOnce('workflow-container-events', ['database-manager', 'redis'],
      async() => {
        await getWorkflowContainerEventBridge().initialize();
        console.log('[Background] Workflow container event bridge initialized');
      },
      async() => { await getWorkflowContainerEventBridge().shutdown() },
    );

    lifecycle.registerOnce('chat-server', ['database-manager'],
      async() => {
        const chatServer = getChatCompletionsServer();

        await chatServer.start();
        console.log('[Background] Chat completions API server started');
      },
      async() => { await getChatCompletionsServer().stop() },
      // stop() sweeps leftover agent containers (bounded at 20s); the default 5s
      // budget reported every quit with containers as a timeout and let the
      // sweep race the VM shutdown.
      { stopTimeoutMs: ChatCompletionsServer.STOP_TIMEOUT_MS },
    );

    // The tunnel authenticates as the vault's principal, so it waits for the
    // unlock and starts the moment it happens instead of on a backoff timer.
    lifecycle.registerOnce('local-tool-tunnel', ['chat-server', 'vault'],
      async() => {
        const { startLocalToolTunnel } = await import('@pkg/main/relayToolTunnel');

        await startLocalToolTunnel();
        console.log('[Background] Local container tool relay connected');
      },
      async() => {
        const { stopLocalToolTunnel } = await import('@pkg/main/relayToolTunnel');

        stopLocalToolTunnel();
      },
      {
        requiresVault: true,
        readiness: () => getSullaFilesWatcher().startupStatus().ready,
        readinessReason: () => {
          const status = getSullaFilesWatcher().startupStatus();

          return status.reason ?? (status.filesUnlocked ? 'Waiting for the FUSE mount token' : 'Files is not unlocked');
        },
      },
    );

    // In-process MCP server that Claude Code (running in the Sulla VM) can call
    // back into. No external deps — pure main-process HTTP server. Must start
    // before any graph execution that invokes Claude Code, which in practice
    // means before the chat server accepts requests.
    lifecycle.registerOnce('mcp-server-host', [],
      async() => {
        await getMCPServerHost().start();
        console.log('[Background] MCP server host started');
      },
      async() => { await getMCPServerHost().stop() },
    );

    lifecycle.registerOnce('headless-browser-reaper', [],
      async() => {
        headlessBrowserReaper.start();
        console.log('[Background] Headless browser reaper started');
      },
      async() => { headlessBrowserReaper.stop() },
    );

    lifecycle.registerOnce('accounts', [],
      async() => {
        const { getSullaAccountsClient, waitForSullaAccountsService } = await import('@pkg/main/sullaAccountsClient');
        const { isSullaOptionalServicePlanned } = await import('@pkg/backend/sullaRuntime/state');

        // Nothing waits on accounts, so it starts alongside everything else.
        // When boot could not set it up this session, say so instead of waiting.
        if (isSullaOptionalServicePlanned('sulla_accounts') === false) {
          throw new Error('Local accounts are not running this session');
        }
        // Boot starts the accounts container after Desktop is usable; wait for it
        // instead of failing and backing off.
        await waitForSullaAccountsService();
        await getSullaAccountsClient().initialize();
        console.log('[Background] Local Accounts broker session initialized');
      },
      async() => {
        const { getSullaAccountsClient } = await import('@pkg/main/sullaAccountsClient');
        getSullaAccountsClient().shutdown();
      },
    );
  }
}
