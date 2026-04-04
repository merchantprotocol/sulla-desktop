// registry.ts (or wherever you centralize registrations)
import * as window from '@pkg/window';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getIntegrationService } from './agent/services/IntegrationService';
import { getSchedulerService } from '@pkg/agent/services/SchedulerService';
import { getHeartbeatService } from '@pkg/agent/services/HeartbeatService';
import { getWorkflowSchedulerService } from '@pkg/agent/services/WorkflowSchedulerService';
import { getExtensionService } from '@pkg/agent/services/ExtensionService';
import { getBackendGraphWebSocketService } from '@pkg/agent/services/BackendGraphWebSocketService';
import { SullaIntegrations } from './agent/integrations';
import { postgresClient } from '@pkg/agent/database/PostgresClient';
import { getChatCompletionsServer } from '@pkg/main/chatCompletionsServer';

import { createN8nService } from './agent/services/N8nService';
import { getDatabaseManager } from '@pkg/agent/database/DatabaseManager';
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
  console.log(`[Shutdown] trySullaComposeDown called — sullaDockerServicesStarted=${ sullaDockerServicesStarted }`);
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

  // NOTE: initSullaEvents() is now called in background.ts before initUI()
  // so handlers are registered before any window can invoke them.

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

    const workflowSchedulerService = getWorkflowSchedulerService();
    await workflowSchedulerService.initialize();
    console.log('[Background] WorkflowSchedulerService initialized - cron-triggered workflows active');

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

    // Unlock the vault before integrations attempt to decrypt credentials
    try {
      const { getVaultKeyService } = await import('@pkg/agent/services/VaultKeyService');
      const vault = getVaultKeyService();
      const unlocked = await vault.initialize();
      console.log(`[Background] Vault initialized: ${ unlocked ? 'unlocked' : 'locked (setup or password required)' }`);
    } catch (err) {
      console.error('[Background] Vault initialization failed:', err);
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

    // MCP servers are initialized lazily — on first tool listing or tool call.
    // This avoids blocking startup for MCP servers that may not be used.
    console.log('[Background] MCP servers will initialize on first use (lazy init)');

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

  // First-chat detection — returns true if the user has never chatted before
  const firstChatLockPath = path.join(app.getPath('userData'), 'first-chat.lock');
  ipcMainProxy.handle('check-first-chat', async() => {
    return !fs.existsSync(firstChatLockPath);
  });
  ipcMainProxy.handle('mark-first-chat-complete', async() => {
    try {
      fs.writeFileSync(firstChatLockPath, new Date().toISOString(), 'utf-8');
    } catch (err) {
      console.error('[Sulla] Failed to write first-chat lock:', err);
    }
  });

  // Execute JavaScript in a child frame (used by BrowserTab iframe bridge injection).
  // When targetUrl is provided, only executes in the frame whose URL matches.
  // Without targetUrl, executes in the first frame that succeeds (legacy behavior).
  ipcMainProxy.handle('browser-tab:exec-in-frame', async(event: Electron.IpcMainInvokeEvent, code: string, targetUrl?: string) => {
    const sender = event.sender;
    const frames = sender.mainFrame.frames;

    // If a target URL is specified, find the matching frame
    if (targetUrl) {
      const targetOrigin = new URL(targetUrl).origin;
      for (const frame of frames) {
        try {
          const frameUrl = frame.url;
          if (frameUrl && new URL(frameUrl).origin === targetOrigin) {
            return await frame.executeJavaScript(code, true);
          }
        } catch { /* skip frames that error */ }
      }
    }

    // Fallback: try all frames (legacy behavior for single-tab usage)
    for (const frame of frames) {
      try {
        return await frame.executeJavaScript(code, true);
      } catch (err) {
        console.warn('[Sulla] browser-tab:exec-in-frame error on frame:', err);
      }
    }

    return undefined;
  });

  // Send trusted keyboard input via Chrome DevTools Protocol (CDP).
  // CDP Input.dispatchKeyEvent produces isTrusted=true events that work
  // inside iframes — unlike sendInputEvent which only targets the top frame.
  ipcMainProxy.handle('browser-tab:send-input-event', async(event: Electron.IpcMainInvokeEvent, inputEvent: { key: string; type: 'keyDown' | 'keyUp' | 'char' }, tabId?: string) => {
    let wc: Electron.WebContents;

    if (tabId) {
      const { BrowserTabViewManager } = await import('@pkg/window/browserTabViewManager');
      const mgr = BrowserTabViewManager.getInstance();
      const viewWc = mgr.getWebContents(tabId);

      if (!viewWc) return false;
      wc = viewWc;
    } else {
      wc = event.sender;
    }

    try {
      // Attach debugger if not already attached
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.3');
      }

      const keyCodeMap: Record<string, { code: string; keyCode: number; text?: string }> = {
        Enter:      { code: 'Enter',      keyCode: 13, text: '\r' },
        Escape:     { code: 'Escape',     keyCode: 27 },
        Tab:        { code: 'Tab',        keyCode: 9 },
        Space:      { code: 'Space',      keyCode: 32, text: ' ' },
        Backspace:  { code: 'Backspace',  keyCode: 8 },
        ArrowUp:    { code: 'ArrowUp',    keyCode: 38 },
        ArrowDown:  { code: 'ArrowDown',  keyCode: 40 },
        ArrowLeft:  { code: 'ArrowLeft',  keyCode: 37 },
        ArrowRight: { code: 'ArrowRight', keyCode: 39 },
      };

      const mapped = keyCodeMap[inputEvent.key] || { code: inputEvent.key, keyCode: 0 };

      const cdpType = inputEvent.type === 'char' ? 'char'
        : inputEvent.type === 'keyUp' ? 'keyUp' : 'rawKeyDown';

      const params: Record<string, unknown> = {
        type:                  cdpType,
        key:                   inputEvent.key,
        code:                  mapped.code,
        windowsVirtualKeyCode: mapped.keyCode,
        nativeVirtualKeyCode:  mapped.keyCode,
      };
      if (cdpType === 'char' && mapped.text) {
        params.text = mapped.text;
        params.unmodifiedText = mapped.text;
      }

      await wc.debugger.sendCommand('Input.dispatchKeyEvent', params);
      return true;
    } catch (err) {
      console.warn('[Sulla] browser-tab:send-input-event CDP error:', err);
      return false;
    }
  });

  // ── Screenshot capture via CDP ───────────────────────────────────────────
  ipcMainProxy.handle('browser-tab:capture-screenshot', async(event: Electron.IpcMainInvokeEvent, options?: {
    format?: 'jpeg' | 'png';
    quality?: number;
    clip?: { x: number; y: number; width: number; height: number; scale?: number };
  }, tabId?: string) => {
    let wc: Electron.WebContents;

    if (tabId) {
      const { BrowserTabViewManager } = await import('@pkg/window/browserTabViewManager');
      const mgr = BrowserTabViewManager.getInstance();
      const viewWc = mgr.getWebContents(tabId);

      if (!viewWc) return null;
      wc = viewWc;
    } else {
      wc = event.sender;
    }

    try {
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.3');
      }

      const cdpParams: Record<string, unknown> = {
        format:               options?.format ?? 'jpeg',
        quality:              options?.quality ?? 80,
        captureBeyondViewport: false,
      };

      if (options?.clip) {
        cdpParams.clip = {
          x:      options.clip.x,
          y:      options.clip.y,
          width:  options.clip.width,
          height: options.clip.height,
          scale:  options.clip.scale ?? 1,
        };
      }

      const result = await wc.debugger.sendCommand('Page.captureScreenshot', cdpParams);

      return {
        base64:    result.data as string,
        mediaType: `image/${ cdpParams.format }`,
      };
    } catch (err) {
      console.warn('[Sulla] browser-tab:capture-screenshot CDP error:', err);
      return null;
    }
  });

  // ── Mouse events via CDP ────────────────────────────────────────────────
  ipcMainProxy.handle('browser-tab:send-mouse-event', async(event: Electron.IpcMainInvokeEvent, mouseEvent: {
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved';
    x: number;
    y: number;
    button?: 'left' | 'right' | 'middle' | 'none';
    clickCount?: number;
  }, tabId?: string) => {
    let wc: Electron.WebContents;

    if (tabId) {
      const { BrowserTabViewManager } = await import('@pkg/window/browserTabViewManager');
      const mgr = BrowserTabViewManager.getInstance();
      const viewWc = mgr.getWebContents(tabId);

      if (!viewWc) return false;
      wc = viewWc;
    } else {
      wc = event.sender;
    }

    try {
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.3');
      }

      await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
        type:       mouseEvent.type,
        x:          mouseEvent.x,
        y:          mouseEvent.y,
        button:     mouseEvent.button ?? 'left',
        clickCount: mouseEvent.clickCount ?? 1,
      });

      return true;
    } catch (err) {
      console.warn('[Sulla] browser-tab:send-mouse-event CDP error:', err);
      return false;
    }
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

  // ── Browser Tab Views (WebContentsView-based) ─────────────────────────────
  const { BrowserTabViewManager } = await import('@pkg/window/browserTabViewManager');
  const tabViewManager = BrowserTabViewManager.getInstance();

  ipcMainProxy.handle('browser-tab-view:create', async(_event: Electron.IpcMainInvokeEvent, tabId: string, url: string, bounds: Electron.Rectangle) => {
    tabViewManager.createView(tabId, url, bounds);
  });

  ipcMainProxy.handle('browser-tab-view:destroy', async(_event: Electron.IpcMainInvokeEvent, tabId: string) => {
    tabViewManager.destroyView(tabId);
  });

  ipcMainProxy.handle('browser-tab-view:navigate', async(_event: Electron.IpcMainInvokeEvent, tabId: string, url: string) => {
    tabViewManager.navigateTo(tabId, url);
  });

  ipcMainProxy.handle('browser-tab-view:go-back', async(_event: Electron.IpcMainInvokeEvent, tabId: string) => {
    tabViewManager.goBack(tabId);
  });

  ipcMainProxy.handle('browser-tab-view:go-forward', async(_event: Electron.IpcMainInvokeEvent, tabId: string) => {
    tabViewManager.goForward(tabId);
  });

  ipcMainProxy.handle('browser-tab-view:reload', async(_event: Electron.IpcMainInvokeEvent, tabId: string) => {
    tabViewManager.reload(tabId);
  });

  ipcMainProxy.handle('browser-tab-view:stop', async(_event: Electron.IpcMainInvokeEvent, tabId: string) => {
    tabViewManager.stop(tabId);
  });

  ipcMainProxy.handle('browser-tab-view:set-bounds', async(_event: Electron.IpcMainInvokeEvent, tabId: string, bounds: Electron.Rectangle) => {
    tabViewManager.setBounds(tabId, bounds);
  });

  ipcMainProxy.handle('browser-tab-view:show', async(_event: Electron.IpcMainInvokeEvent, tabId: string) => {
    tabViewManager.showView(tabId);
  });

  ipcMainProxy.handle('browser-tab-view:hide', async(_event: Electron.IpcMainInvokeEvent, tabId: string) => {
    tabViewManager.hideView(tabId);
  });

  ipcMainProxy.handle('browser-tab-view:exec-js', async(_event: Electron.IpcMainInvokeEvent, tabId: string, code: string) => {
    return tabViewManager.executeJavaScript(tabId, code);
  });

  // ── Vault: key management IPC handlers (main-process only — safeStorage) ──
  const { getVaultKeyService } = await import('@pkg/agent/services/VaultKeyService');
  const vaultKey = getVaultKeyService();

  ipcMainProxy.handle('vault:is-setup', async() => {
    return vaultKey.isSetUp();
  });

  ipcMainProxy.handle('vault:can-verify', async() => {
    return vaultKey.canVerifyPassword();
  });

  ipcMainProxy.handle('vault:is-unlocked', async() => {
    return vaultKey.isUnlocked();
  });

  ipcMainProxy.handle('vault:initialize', async() => {
    return vaultKey.initialize();
  });

  ipcMainProxy.handle('vault:setup', async(_event: Electron.IpcMainInvokeEvent, data: { masterPassword: string }) => {
    const result = await vaultKey.setupFromMasterPassword(data.masterPassword);
    const { setUserLoggedIn } = await import('@pkg/main/mainmenu');
    setUserLoggedIn(true);
    return { recoveryKey: result.recoveryKey };
  });

  ipcMainProxy.handle('vault:change-password', async(_event: Electron.IpcMainInvokeEvent, data: { newPassword: string }) => {
    const { IntegrationValueModel } = await import('@pkg/agent/database/models/IntegrationValueModel');
    const { recoveryKey, oldDecrypt } = await vaultKey.changePassword(data.newPassword);
    await IntegrationValueModel.reEncryptAll(oldDecrypt);
    return { recoveryKey };
  });

  ipcMainProxy.handle('vault:unlock-password', async(_event: Electron.IpcMainInvokeEvent, data: { password: string }) => {
    const success = await vaultKey.recoverFromMasterPassword(data.password);
    if (success) {
      const { setUserLoggedIn } = await import('@pkg/main/mainmenu');
      setUserLoggedIn(true);
    }
    return success;
  });

  ipcMainProxy.handle('vault:unlock-recovery', async(_event: Electron.IpcMainInvokeEvent, data: { recoveryKey: string }) => {
    const success = await vaultKey.recoverFromRecoveryKey(data.recoveryKey);
    if (success) {
      const { setUserLoggedIn } = await import('@pkg/main/mainmenu');
      setUserLoggedIn(true);
    }
    return success;
  });

  ipcMainProxy.handle('vault:logout', async() => {
    // UI logout only — do NOT zero the VMK so the agent can keep working
    const { setUserLoggedIn } = await import('@pkg/main/mainmenu');
    setUserLoggedIn(false);
    // Hide native browser tab views so the login screen is visible
    tabViewManager.hideAllViews();
    return true;
  });

  ipcMainProxy.handle('vault:lock-vault', async() => {
    // Manual vault lock — zeros VMK, agent loses access to encrypted credentials
    vaultKey.lock();
    const { setUserLoggedIn } = await import('@pkg/main/mainmenu');
    setUserLoggedIn(false);
    // Hide native browser tab views so the login screen is visible
    tabViewManager.hideAllViews();
    return true;
  });

  // Sync decrypt/encrypt for renderer-side IntegrationValueModel
  const { ipcMain } = await import('electron');
  ipcMain.on('vault:decrypt-sync', (event, encrypted: string) => {
    try {
      if (vaultKey.isUnlocked() && vaultKey.isEncrypted(encrypted)) {
        event.returnValue = vaultKey.decrypt(encrypted);
      } else {
        event.returnValue = encrypted;
      }
    } catch {
      event.returnValue = encrypted;
    }
  });

  ipcMain.on('vault:encrypt-sync', (event, plaintext: string) => {
    try {
      if (vaultKey.isUnlocked()) {
        event.returnValue = vaultKey.encrypt(plaintext);
      } else {
        event.returnValue = plaintext;
      }
    } catch {
      event.returnValue = plaintext;
    }
  });

  // ── Vault: export & import ─────────────────────────────────────────────────
  const { dialog } = await import('electron');
  const fsPromises = await import('fs/promises');

  ipcMainProxy.handle('vault:export', async(_event: Electron.IpcMainInvokeEvent, data: { encrypted: boolean }) => {
    try {
      const { getIntegrationService: getIS } = await import('@pkg/agent/services/IntegrationService');
      const service = getIS();
      await service.initialize();

      const enabled = await service.getEnabledIntegrations();
      const exportData: any[] = [];

      for (const { integrationId, accounts } of enabled) {
        for (const acct of accounts) {
          const formValues = await service.getFormValues(integrationId, acct.account_id);
          const values: Record<string, string> = {};
          for (const fv of formValues) {
            values[fv.property] = fv.value;
          }
          exportData.push({
            integrationId,
            accountId:  acct.account_id,
            label:      acct.label,
            connected:  acct.connected,
            active:     acct.active,
            values,
          });
        }
      }

      let content: string;
      let defaultName: string;

      if (data.encrypted) {
        const vault = getVaultKeyService();
        if (!vault.isUnlocked()) {
          return { success: false, error: 'Vault is locked' };
        }
        content = vault.encrypt(JSON.stringify(exportData, null, 2));
        defaultName = `sulla-vault-backup-${ new Date().toISOString().slice(0, 10) }.enc`;
      } else {
        content = JSON.stringify(exportData, null, 2);
        defaultName = `sulla-vault-export-${ new Date().toISOString().slice(0, 10) }.json`;
      }

      const mainWindow = window.getWindow('main-agent');
      const result = await dialog.showSaveDialog(mainWindow!, {
        title:       data.encrypted ? 'Export Encrypted Vault Backup' : 'Export Vault (Plain Text)',
        defaultPath: defaultName,
        filters:     data.encrypted
          ? [{ name: 'Encrypted Backup', extensions: ['enc'] }]
          : [{ name: 'JSON', extensions: ['json'] }],
      });

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      await fsPromises.writeFile(result.filePath, content, 'utf-8');
      console.log(`[Vault] Exported ${ exportData.length } accounts to ${ result.filePath }`);
      return { success: true, count: exportData.length, path: result.filePath };
    } catch (err: any) {
      console.error('[Vault] Export failed:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMainProxy.handle('vault:import', async() => {
    try {
      const mainWindow = window.getWindow('main-agent');
      const result = await dialog.showOpenDialog(mainWindow!, {
        title:      'Import Passwords',
        filters:    [
          { name: 'Password Files', extensions: ['json', 'csv', 'enc'] },
          { name: 'All Files', extensions: ['*'] },
        ],
        properties: ['openFile'],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      const filePath = result.filePaths[0];
      let raw = await fsPromises.readFile(filePath, 'utf-8');

      // Detect Sulla encrypted file
      if (raw.startsWith('$VAULT$')) {
        const vault = getVaultKeyService();
        if (!vault.isUnlocked()) {
          return { success: false, error: 'Vault is locked — cannot decrypt backup' };
        }
        try {
          raw = vault.decrypt(raw);
        } catch {
          return { success: false, error: 'Failed to decrypt — wrong vault key or corrupted file' };
        }
      }

      // ── Detect format and normalize to a common shape ──
      interface ImportEntry { label: string; url: string; username: string; password: string; notes: string; totp: string; folder: string }
      let entries: ImportEntry[] = [];
      let format = 'unknown';

      // Try JSON first (Sulla native or Bitwarden JSON)
      try {
        const parsed = JSON.parse(raw);

        if (Array.isArray(parsed) && parsed[0]?.integrationId) {
          // ── Sulla native format ──
          format = 'sulla';
          const { getIntegrationService: getIS } = await import('@pkg/agent/services/IntegrationService');
          const svc = getIS();
          await svc.initialize();
          let imported = 0;
          for (const acct of parsed) {
            if (!acct.integrationId || !acct.accountId || !acct.values) continue;
            const inputs = Object.entries(acct.values as Record<string, string>).map(([key, value]) => ({
              integration_id: acct.integrationId, account_id: acct.accountId, property: key, value,
            }));
            await svc.setFormValues(inputs);
            if (acct.label) await svc.setAccountLabel(acct.integrationId, acct.accountId, acct.label);
            if (acct.connected !== false) await svc.setConnectionStatus(acct.integrationId, true, acct.accountId);
            imported++;
          }
          console.log(`[Vault] Imported ${ imported } accounts (Sulla format) from ${ filePath }`);
          return { success: true, count: imported, format };
        }

        if (parsed.encrypted !== undefined && parsed.items) {
          // ── Bitwarden JSON export ──
          format = 'bitwarden-json';
          for (const item of parsed.items) {
            if (item.type !== 1) continue; // type 1 = login
            entries.push({
              label:    item.name || '',
              url:      item.login?.uris?.[0]?.uri || '',
              username: item.login?.username || '',
              password: item.login?.password || '',
              notes:    item.notes || '',
              totp:     item.login?.totp || '',
              folder:   '',
            });
          }
        }
      } catch {
        // Not JSON — try CSV
      }

      // ── CSV parsing ──
      if (entries.length === 0 && !raw.startsWith('{') && !raw.startsWith('[')) {
        const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length < 2) {
          return { success: false, error: 'File is empty or has no data rows' };
        }

        const headerLine = lines[0].toLowerCase();
        const headers = parseCSVLine(headerLine);
        const dataLines = lines.slice(1);

        if (headers.includes('login_uri') || headers.includes('login_username')) {
          // ── Bitwarden CSV ──
          format = 'bitwarden-csv';
          const col = (row: string[], name: string) => row[headers.indexOf(name)] || '';
          for (const line of dataLines) {
            const row = parseCSVLine(line);
            if (col(row, 'type') !== 'login' && col(row, 'type') !== '') continue;
            entries.push({
              label:    col(row, 'name'),
              url:      col(row, 'login_uri'),
              username: col(row, 'login_username'),
              password: col(row, 'login_password'),
              notes:    col(row, 'notes'),
              totp:     col(row, 'login_totp'),
              folder:   col(row, 'folder'),
            });
          }
        } else if (headers.includes('url') && headers.includes('username') && headers.includes('grouping')) {
          // ── LastPass CSV ──
          format = 'lastpass';
          const col = (row: string[], name: string) => row[headers.indexOf(name)] || '';
          for (const line of dataLines) {
            const row = parseCSVLine(line);
            entries.push({
              label:    col(row, 'name'),
              url:      col(row, 'url'),
              username: col(row, 'username'),
              password: col(row, 'password'),
              notes:    col(row, 'extra'),
              totp:     col(row, 'totp'),
              folder:   col(row, 'grouping'),
            });
          }
        } else if (headers.includes('title') || headers.includes('username')) {
          // ── 1Password CSV or generic CSV ──
          format = '1password';
          const col = (row: string[], name: string) => row[headers.indexOf(name)] || '';
          for (const line of dataLines) {
            const row = parseCSVLine(line);
            entries.push({
              label:    col(row, 'title') || col(row, 'name'),
              url:      col(row, 'url') || col(row, 'login_uri'),
              username: col(row, 'username') || col(row, 'login_username'),
              password: col(row, 'password') || col(row, 'login_password'),
              notes:    col(row, 'notes') || col(row, 'extra'),
              totp:     col(row, 'totp') || '',
              folder:   col(row, 'folder') || col(row, 'grouping') || col(row, 'vault') || '',
            });
          }
        } else {
          return { success: false, error: `Unrecognized CSV format. Headers found: ${ headers.join(', ') }. Supported: Bitwarden, LastPass, 1Password, or Sulla JSON.` };
        }
      }

      if (entries.length === 0 && format === 'unknown') {
        return { success: false, error: 'No importable entries found in file' };
      }

      // ── Save entries as website integration accounts ──
      const { getIntegrationService: getIS } = await import('@pkg/agent/services/IntegrationService');
      const service = getIS();
      await service.initialize();

      let imported = 0;
      for (const entry of entries) {
        if (!entry.username && !entry.password) continue;

        const accountId = ((entry.url || 'unknown') + '_' + (entry.username || 'unknown'))
          .toLowerCase()
          .replace(/^https?:\/\//, '')
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_|_$/g, '')
          .slice(0, 200);

        const values: { integration_id: string; account_id: string; property: string; value: string }[] = [
          { integration_id: 'website', account_id: accountId, property: 'website_url', value: entry.url },
          { integration_id: 'website', account_id: accountId, property: 'username', value: entry.username },
          { integration_id: 'website', account_id: accountId, property: 'password', value: entry.password },
          { integration_id: 'website', account_id: accountId, property: 'llm_access', value: 'autofill' },
        ];
        if (entry.notes) {
          values.push({ integration_id: 'website', account_id: accountId, property: 'notes', value: entry.notes });
        }
        if (entry.totp) {
          values.push({ integration_id: 'website', account_id: accountId, property: 'custom_totp', value: entry.totp });
        }

        await service.setFormValues(values);

        const label = entry.label || (entry.url ? entry.url.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : 'Imported');
        await service.setAccountLabel('website', accountId, `${ label } (${ entry.username })`);
        await service.setConnectionStatus('website', true, accountId);
        imported++;
      }

      console.log(`[Vault] Imported ${ imported } entries (${ format }) from ${ filePath }`);
      return { success: true, count: imported, format };
    } catch (err: any) {
      console.error('[Vault] Import failed:', err);
      return { success: false, error: err.message };
    }
  });

  /** Parse a CSV line respecting quoted fields */
  function parseCSVLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  }

  // ── Vault: credential save & autofill IPC handlers ────────────────────────
  const { getIntegrationService } = await import('@pkg/agent/services/IntegrationService');

  ipcMainProxy.handle('vault:save-credential', async(_event: Electron.IpcMainInvokeEvent, data: { origin: string; username: string; password: string }) => {
    try {
      const service = getIntegrationService();
      await service.initialize();

      // Generate account ID from origin + username
      const accountId = (data.origin + '_' + data.username)
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 200);

      // Save as a website integration account
      await service.setFormValues([
        { integration_id: 'website', account_id: accountId, property: 'website_url', value: data.origin },
        { integration_id: 'website', account_id: accountId, property: 'username', value: data.username },
        { integration_id: 'website', account_id: accountId, property: 'password', value: data.password },
        { integration_id: 'website', account_id: accountId, property: 'llm_access', value: 'autofill' },
      ]);

      // Set account label and mark as connected
      await service.setAccountLabel('website', accountId, `${ data.username } @ ${ data.origin.replace(/^https?:\/\//, '') }`);
      await service.setConnectionStatus('website', true, accountId);

      console.log(`[Vault] Saved credential for ${ data.origin } (${ data.username })`);
      return { success: true, accountId };
    } catch (err: any) {
      console.error('[Vault] Failed to save credential:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMainProxy.handle('vault:autofill', async(_event: Electron.IpcMainInvokeEvent, data: { tabId?: string; accountId: string }) => {
    try {
      const service = getIntegrationService();
      await service.initialize();

      // Get the saved credentials for this account
      const formValues = await service.getFormValues('website', data.accountId);
      const storedValues: Record<string, string> = {};
      for (const fv of formValues) {
        storedValues[fv.property] = fv.value;
      }

      const username = storedValues['username'] || '';
      const password = storedValues['password'] || '';

      if (!username || !password) {
        console.warn('[Vault] Autofill: missing username or password for account', data.accountId);
        return { success: false, error: 'Missing credentials' };
      }

      // Find the active tab to autofill — if tabId provided use it,
      // otherwise find the first visible browser tab with a matching origin
      let targetTabId = data.tabId;

      if (!targetTabId) {
        // Try to find the tab from the main window's rendered browser tabs
        // For now, we'll need the tabId passed from the renderer
        console.warn('[Vault] Autofill: no tabId provided');
        return { success: false, error: 'No target tab specified' };
      }

      // Execute autofill in the target tab — password goes directly to the
      // browser tab via executeJavaScript, never enters the LLM context
      const fillScript = `
        (function() {
          var bridge = window.sullaBridge;
          if (!bridge) return { success: false, error: 'Bridge not available' };

          var loginForm = bridge.detectLoginForm();
          if (!loginForm || !loginForm.hasLoginForm) return { success: false, error: 'No login form found' };

          var usernameOk = false;
          var passwordOk = false;

          if (loginForm.usernameHandle) {
            usernameOk = bridge.setValue(loginForm.usernameHandle, ${ JSON.stringify(username) });
          }
          if (loginForm.passwordHandle) {
            passwordOk = bridge.setValue(loginForm.passwordHandle, ${ JSON.stringify(password) });
          }

          return { success: usernameOk || passwordOk, usernameOk: usernameOk, passwordOk: passwordOk };
        })();
      `;

      const result = await tabViewManager.executeJavaScript(targetTabId, fillScript);
      console.log(`[Vault] Autofill result for ${ data.accountId }:`, result);
      return { success: true, ...(result as any) };
    } catch (err: any) {
      console.error('[Vault] Autofill failed:', err);
      return { success: false, error: err.message };
    }
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
  // Window close is now handled by FirstRunCoordinator in background.ts

  app.on('will-quit', async() => {
    console.log('[Shutdown] will-quit fired');
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
    console.log(`[Shutdown] will-quit: about to call trySullaComposeDown — sullaDockerServicesStarted=${ sullaDockerServicesStarted }`);
    trySullaComposeDown();
  });

  Electron.app.on('before-quit', async() => {
    console.log('[Shutdown] sulla.ts before-quit handler fired');
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
    await chatServer.stop();
  } catch (error) {
    console.error('[Background] Error stopping chat completions server:', error);
  }

  try {
    const { getTerminalServer } = await import('@pkg/main/terminalServer');
    await getTerminalServer().stop();
  } catch (error) {
    console.error('[Background] Error stopping terminal server:', error);
  }
};
