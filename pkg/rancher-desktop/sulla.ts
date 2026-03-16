// registry.ts (or wherever you centralize registrations)
import * as window from '@pkg/window';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getIntegrationService } from './agent/services/IntegrationService';
import { getSchedulerService } from '@pkg/agent/services/SchedulerService';
import { getHeartbeatService } from '@pkg/agent/services/HeartbeatService';
import { getExtensionService } from '@pkg/agent/services/ExtensionService';
import { getBackendGraphWebSocketService } from '@pkg/agent/services/BackendGraphWebSocketService';
import { SullaIntegrations } from './agent/integrations';
import { postgresClient } from '@pkg/agent/database/PostgresClient';
import { getChatCompletionsServer } from '@pkg/main/chatCompletionsServer';

import { createN8nService } from './agent/services/N8nService';
import { getDatabaseManager } from '@pkg/agent/database/DatabaseManager';
import { initSullaEvents } from '@pkg/main/sullaEvents';
import { bootstrapSullaHome } from '@pkg/agent/utils/sullaPaths';
import { getLlamaCppService } from '@pkg/agent/services/LlamaCppService';
import * as path from 'path';
import { app, webContents } from 'electron';
import { execSync } from 'child_process';
import * as fs from 'fs';
import { submitErrorReport } from '@pkg/main/errorReporter';
import Logging from '@pkg/utils/logging';

const console = Logging.sulla;

/** Track whether Sulla services were actually started during this session. */
let sullaDockerServicesStarted = false;

/** When true, the app is restarting — skip Docker Compose teardown. */
let sullaIsRestarting = false;

export function markSullaRestarting(): void {
  console.log('[Shutdown] markSullaRestarting() called — sullaIsRestarting=true');
  sullaIsRestarting = true;
}

export function markSullaDockerServicesStarted(): void {
  sullaDockerServicesStarted = true;
}

/**
 * Check if the Docker daemon socket is reachable before attempting compose commands.
 */
const isDockerDaemonRunning = (): boolean => {
  try {
    // Quick socket existence check first
    if (!fs.existsSync('/var/run/docker.sock')) {
      return false;
    }
    execSync('docker info', { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

const checkDockerMode = async() => {
  try {
    let resourcesPath;
    if (process.resourcesPath.includes('node_modules/electron')) {
      // Development: use source resources
      resourcesPath = path.join(__dirname, '../../../resources');
    } else {
      // Production: use app resources
      resourcesPath = process.resourcesPath;
    }
    const limactlPath = path.join(resourcesPath, 'darwin/lima/bin/limactl');
    const output = execSync(`LIMA_HOME=~/Library/Application\\ Support/rancher-desktop/lima "${ limactlPath }" list --json`, { encoding: 'utf8' });
    const instances = JSON.parse(output);
    const instance = instances.find((i: any) => i.name === '0');
    const vmRunning = instance?.status === 'Running';

    // Check if Kubernetes is enabled
    const k8sEnabled = await SullaSettingsModel.get('kubernetes.enabled', false);

    // We're in Docker mode if VM is not running OR Kubernetes is not enabled
    return !vmRunning || !k8sEnabled;
  } catch (err) {
    // If we can't determine state, do NOT assume Docker mode — nothing to tear down
    return false;
  }
};

/**
 * Attempt to stop Sulla Docker Compose services.
 * Only runs if services were actually started this session AND Docker daemon is reachable.
 */
const trySullaComposeDown = (): void => {
  console.log(`[Shutdown] trySullaComposeDown called — sullaIsRestarting=${ sullaIsRestarting }, sullaDockerServicesStarted=${ sullaDockerServicesStarted }`);
  if (sullaIsRestarting) {
    console.log('[Shutdown] Skipping compose down — app is restarting');

    return;
  }
  if (!sullaDockerServicesStarted) {
    console.log('[Shutdown] Skipping compose down — services were not started this session');
    return;
  }
  if (!isDockerDaemonRunning()) {
    console.log('[Shutdown] Docker daemon not running, skipping compose down');
    return;
  }
  try {
    const composeFilePath = path.join(process.cwd(), 'pkg/rancher-desktop/assets/sulla-docker-compose.yaml');
    execSync(`docker-compose -f "${ composeFilePath }" down`, { cwd: process.cwd(), stdio: 'inherit', timeout: 30000 });
    console.log('[Shutdown] Docker containers stopped');
  } catch (err) {
    console.warn('[Shutdown] Docker compose down failed:', err);
  }
};

export async function initiateWindowContext(): Promise<void> {
  // This function serves as the explicit initialization hook
  console.log('[WindowContext] Sulla window context initialized');

  // Get the user data path from main process
  const { ipcRenderer } = require('electron');
  try {
    const userDataPath = await ipcRenderer.invoke('get-user-data-path');
    const fallbackPath = require('path').join(userDataPath, 'sulla-settings-fallback.json');
    SullaSettingsModel.setFallbackFilePath(fallbackPath);
    console.log('[WindowContext] Fallback path set to:', fallbackPath);

    await SullaSettingsModel.bootstrap();
  } catch (error) {
    console.error('[WindowContext] Failed to initialize settings:', error);
  }

  // Initialize extension service
  try {
    const extensionService = getExtensionService();
    await extensionService.initialize();
  } catch (error) {
    console.error('[ExtensionService] Failed to initialize:', error);
  }
}

/**
 * Initialize all Sulla integrations
 *
 * This function is called during application startup to set up all integration factories
 *
 * @see sulla-desktop/background.ts
 */
export async function instantiateSullaStart(): Promise<void> {
  // Integration factories are already registered above
  // This function serves as the explicit initialization hook
  console.log('[Integrations] Sulla integrations initialized');

  // Initialize Sulla-specific IPC handlers early so they are available
  // before any async work (windows may open before DB/services are ready).
  initSullaEvents();

  // Bootstrap ~/sulla directory structure and clone default repos if needed.
  await bootstrapSullaHome();

  try {
    const backendGraphWebSocketService = getBackendGraphWebSocketService();
    console.log('[Background] BackendGraphWebSocketService initialized - backend agent messages will be processed');

    // PG connection issue
    process.on('unhandledRejection', (reason: any) => {
      if (reason?.code === '57P01') {
        console.warn('[Unhandled] Ignored Postgres admin termination');

        return;
      }
      console.error('[Unhandled Rejection]', reason);
      const err = reason instanceof Error ? reason : new Error(String(reason));

      submitErrorReport({
        error_type:    err.name || 'unhandledRejection',
        error_message: err.message,
        stack_trace:   err.stack || '',
        user_context:  'unhandledRejection in sulla.ts (Sulla services)',
      }).catch(() => {});
    });

    await afterBackgroundLoaded();

    const schedulerService = getSchedulerService();
    await schedulerService.initialize();
    console.log('[Background] SchedulerService initialized - calendar events will trigger in background');

    const heartbeatService = getHeartbeatService();
    await heartbeatService.initialize();
    console.log('[Background] HeartbeatService initialized - periodic tasks will run in background');

    // Start the chat completions API server
    console.log('[Background] Starting chat completions API server...');
    try {
      console.log('[Background] Chat completions server instance created');
      const chatServer = getChatCompletionsServer();
      await chatServer.start();
      console.log('[Background] Chat completions API server started successfully');
    } catch (error) {
      console.error('[Background] Failed to start chat completions API server:', error);
    }

    SullaIntegrations();

    // Load YAML-defined API integrations from ~/sulla/integrations
    try {
      const { getIntegrationConfigLoader } = await import('@pkg/agent/integrations/configApi');
      const configLoader = getIntegrationConfigLoader();
      await configLoader.loadAll();
      console.log('[Background] IntegrationConfigLoader ready:', configLoader.getAvailableIntegrations().join(', ') || '(none)');
    } catch (error) {
      console.error('[Background] Failed to load integration configs:', error);
    }

    // Resume OAuth token refresh timers for any previously connected OAuth integrations
    try {
      const { getOAuthService } = await import('@pkg/agent/services/OAuthService');
      const oauthService = getOAuthService();
      await oauthService.resumeRefreshTimers();
      console.log('[Background] OAuthService refresh timers resumed');
    } catch (error) {
      console.error('[Background] Failed to resume OAuth refresh timers:', error);
    }

    // Ensure llama.cpp binaries are installed, download user's model, and start server
    try {
      const llamaCppService = getLlamaCppService();
      await llamaCppService.ensure();
      console.log('[Background] LlamaCppService initialized - llama.cpp ready:', llamaCppService.isReady);

      if (llamaCppService.isReady) {
        // Read the user's selected model from settings
        const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');
        const { GGUF_MODELS } = await import('@pkg/agent/services/LlamaCppService');
        let modelKey = await SullaSettingsModel.get('sullaModel', 'qwen3.5-9b');

        // Map legacy Ollama-format keys (e.g. 'qwen2:0.5b') to GGUF keys (e.g. 'qwen2-0.5b')
        if (!(modelKey in GGUF_MODELS)) {
          const mapped = modelKey.replace(/:/g, '-');
          if (mapped in GGUF_MODELS) {
            console.log(`[Background] Mapped legacy model key '${ modelKey }' -> '${ mapped }'`);
            modelKey = mapped;
          } else {
            console.warn(`[Background] Unknown model key '${ modelKey }', falling back to qwen3.5-9b`);
            modelKey = 'qwen3.5-9b';
          }
        }
        console.log(`[Background] User selected model: ${ modelKey }`);

        // Download the GGUF model (no-ops if already on disk)
        const modelPath = await llamaCppService.downloadModel(modelKey);
        console.log(`[Background] Model ready at: ${ modelPath }`);

        // Start llama-server on port 30114
        await llamaCppService.startServer(modelPath);
        console.log(`[Background] llama-server running at ${ llamaCppService.serverBaseUrl }`);

        // Training deps are NOT installed at startup.
        // They are installed on-demand when the user opens the Model Training
        // window and clicks "Install Training Environment".
      }
    } catch (error) {
      console.error('[Background] Failed to start llama.cpp server:', error);
    }
  } catch (ex: any) {
    console.error('[Background] Failed to initialize Sulla:', ex);
  }
}

/**
 *
 * @see sulla-desktop/background.ts
 */
export async function onMainProxyLoad(ipcMainProxy: any) {
  // Assume main process
  const fallbackPath = path.join(app.getPath('userData'), 'sulla-settings-fallback.json');
  SullaSettingsModel.setFallbackFilePath(fallbackPath);
  SullaSettingsModel.set('pathUserData', app.getPath('userData'), 'string');

  // Start the terminal WebSocket server early (PTY into Lima VM)
  // Dynamic import to avoid bundling node-pty into the renderer process
  // The server starts immediately but individual sessions check Lima status on connect
  try {
    const { getTerminalServer } = await import('@pkg/main/terminalServer');
    const termServer = getTerminalServer();
    await termServer.start();
    console.log('[Background] Terminal WebSocket server started on ws://127.0.0.1:6108');
  } catch (error) {
    console.error('[Background] Failed to start terminal WebSocket server:', error);
  }

  // Cache it in settings on first request
  ipcMainProxy.handle('get-user-data-path', async() => {
    return app.getPath('userData');
  });

  // Execute JavaScript in a child frame (used by BrowserTab iframe bridge injection)
  ipcMainProxy.handle('browser-tab:exec-in-frame', async(event: Electron.IpcMainInvokeEvent, code: string) => {
    const sender = event.sender;
    const frames = sender.mainFrame.frames;

    for (const frame of frames) {
      try {
        return await frame.executeJavaScript(code, true);
      } catch (err) {
        console.warn('[Sulla] browser-tab:exec-in-frame error on frame:', err);
      }
    }

    return undefined;
  });

  // Handle app quit requests from the UI
  ipcMainProxy.handle('app-quit', async() => {
    console.log('[Sulla] Quitting application...');
    const firstRunWindow = window.getWindow('first-run');
    if (firstRunWindow) {
      firstRunWindow.setClosable(true);
      firstRunWindow.close();
    }

    app.quit();
  });
}

/**
 *
 * @see sulla-desktop/background.ts
 */
export async function afterBackgroundLoaded() {
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

  // Initialize N8nService (reads API key from settings, no DB model dependency)
  await createN8nService();
}

/**
 * Application shutdown graceful commands
 *
 * @see sulla-desktop/background.ts
 */
export function hookSullaEnd(Electron: any, mainEvents: any, window:any) {
  mainEvents.on('sulla-first-run-complete', () => {
    const firstRunWindow = window.getWindow('first-run');
    firstRunWindow?.setClosable(true);
    firstRunWindow?.close();
    window.openMain();
  });

  app.on('will-quit', async() => {
    console.log(`[Shutdown] will-quit fired — sullaIsRestarting=${ sullaIsRestarting }`);
    // Clear OAuth refresh timers
    try {
      const { getOAuthService } = await import('@pkg/agent/services/OAuthService');
      getOAuthService().shutdown();
      console.log('[Shutdown] OAuth refresh timers cleared');
    } catch { /* OAuthService may not have been initialized */ }

    try {
      await getDatabaseManager().stop();
      console.log('[Shutdown] Postgres closed');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.warn('[Shutdown] Postgres close failed:', errorMessage);
    }

    // Stop Docker containers only if they were started this session
    console.log(`[Shutdown] will-quit: about to call trySullaComposeDown — sullaIsRestarting=${ sullaIsRestarting }, sullaDockerServicesStarted=${ sullaDockerServicesStarted }`);
    trySullaComposeDown();
  });

  Electron.app.on('before-quit', async() => {
    console.log(`[Shutdown] sulla.ts before-quit handler fired — sullaIsRestarting=${ sullaIsRestarting }`);
    try {
      await getDatabaseManager().stop();
    } catch { } // swallow any remaining errors
  });

  process.on('SIGTERM', async() => {
    console.log('[Shutdown] SIGTERM received — closing postgres and quitting');
    await postgresClient.end();
    app.quit();
  });
  process.on('SIGINT', async() => {
    console.log('[Shutdown] SIGINT received — closing postgres and quitting');
    await postgresClient.end();
    app.quit();
  });
}

/**
 *
 * @see sulla-desktop/background.ts
 */
export async function sullaEnd(event: any) {
  try {
    const chatServer = getChatCompletionsServer();
    chatServer.stop();
  } catch (error) {
    console.error('[Background] Error stopping chat completions server:', error);
  }

  try {
    const { getTerminalServer } = await import('@pkg/main/terminalServer');
    getTerminalServer().stop();
  } catch (error) {
    console.error('[Background] Error stopping terminal server:', error);
  }
};
