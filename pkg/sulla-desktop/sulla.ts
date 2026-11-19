// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// registry.ts (or wherever you centralize registrations)
// NOTE: import order matters here — `@pkg/window` must be imported FIRST to
// avoid a circular-dependency runtime error ("Cannot access 'a' before
// initialization") in the renderer bundle. Do not let linters reorder these.
import * as window from '@pkg/window';
import { vaultViewManager } from '@pkg/window/vaultViewManager';
// Keep the startup modules evaluating in the order sulla.ts has always loaded
// them (these used to be named imports here); providers below import them too.
import '@pkg/agent/database/models/SullaSettingsModel';
import './agent/services/IntegrationService';
import '@pkg/agent/services/SchedulerService';
import '@pkg/agent/services/HeartbeatService';
import '@pkg/agent/services/WorkflowSchedulerService';
import '@pkg/agent/services/WorkflowContainerEventBridge';
import '@pkg/agent/services/ExtensionService';
import '@pkg/agent/services/BackendGraphWebSocketService';
import './agent/integrations';
import '@pkg/agent/database/PostgresClient';
import '@pkg/agent/database/RedisClient';
import '@pkg/main/chatCompletionsServer';
import '@pkg/main/MCPServerHost';
import '@pkg/main/HeadlessBrowserReaper';
import '@pkg/main/eventLoopLagMonitor';
import '@pkg/agent/extensions/ExtensionLoader';
import '@pkg/agent/database/DatabaseManager';
import '@pkg/agent/utils/sullaPaths';
import '@pkg/main/browserTabs/syntheticInput';
import '@pkg/agent/services/ServiceLifecycleManager';
import '@pkg/main/sullaFilesWatcher';

import { MainProcessIpcContext } from '@pkg/main/startup/MainProcessIpcContext';
import { SullaStartup } from '@pkg/main/startup/SullaStartup';

/** The one startup composition root; constructing it does no work. */
const sullaStartup = new SullaStartup();

/** Track whether Sulla services were actually started during this session. */
export function markSullaDockerServicesStarted(): void {
  sullaStartup.dockerServices.markStarted();
}

export function initiateWindowContext(): Promise<void> {
  return sullaStartup.windowContext.initialize();
}

/** Hydrate renderer-only state in the background so the agent shell can paint. */
export function startWindowContextHydration(): void {
  sullaStartup.windowContext.startForFirstPaint();
}

export function expectVaultContainer(): void {
  sullaStartup.vaultState.expectContainer();
}

export function markVaultContainerReady(): void {
  sullaStartup.vaultState.markContainerReady();
}

/** Refresh non-secret state only; migration and backup run inside the container. */
export function onVaultUnlocked(): Promise<void> {
  return sullaStartup.vaultState.onVaultUnlocked();
}

/**
 * Initialize all Sulla integrations
 *
 * This function is called during application startup to set up all integration factories
 *
 * @see sulla-desktop/background.ts
 */
export async function instantiateSullaStart(assertCurrent?: () => void): Promise<void> {
  const { agentExecutionReadiness } = await import('@pkg/agent/services/AgentExecutionReadiness');
  agentExecutionReadiness.activate();
  return sullaStartup.services.start(assertCurrent);
}

/**
 *
 * @see sulla-desktop/background.ts
 */
export function onMainProxyLoad(ipcProxy: any): Promise<void> {
  return sullaStartup.mainProcessIpc.load(new MainProcessIpcContext(ipcProxy, window, vaultViewManager, sullaStartup.vaultState));
}

/**
 *
 * @see sulla-desktop/background.ts
 */
export function afterBackgroundLoaded(): Promise<void> {
  return sullaStartup.coreServices.initializeDatabase();
}

/**
 * Application shutdown graceful commands.
 * All service teardown is handled by ServiceLifecycleManager.stopAll().
 * Only SIGTERM/SIGINT are registered here as emergency fallbacks.
 *
 * @see sulla-desktop/background.ts
 */
export function hookSullaEnd(Electron: any, mainEvents: any, window:any): void {
  sullaStartup.shutdown.hookSignals();
}

/**
 *
 * @see sulla-desktop/background.ts
 */
export function sullaEnd(mode: 'full' | 'restart' = 'full'): Promise<void> {
  return sullaStartup.shutdown.end(mode);
}
