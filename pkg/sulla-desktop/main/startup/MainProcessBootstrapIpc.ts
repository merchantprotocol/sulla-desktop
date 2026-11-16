// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import * as fs from 'fs';
import * as path from 'path';

import { app } from 'electron';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { loopbackOrigin } from '@pkg/utils/instance';
import Logging from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';

import type { MainProcessIpcContext, MainProcessIpcStep } from './MainProcessIpcContext';

const console = Logging.sulla;

/** Settings fallback, terminal server, early model-provider IPC, onboarding/first-chat checks and app quit. */
export class MainProcessBootstrapIpc implements MainProcessIpcStep {
  readonly name = 'bootstrap';

  async register(ctx: MainProcessIpcContext): Promise<void> {
    const { ipc, window } = ctx;

    // Assume main process
    const fallbackPath = path.join(app.getPath('userData'), 'sulla-settings-fallback.json');
    SullaSettingsModel.setFallbackFilePath(fallbackPath);
    SullaSettingsModel.set('pathUserData', app.getPath('userData'), 'string');

    // Start the terminal WebSocket server early (PTY into Sulla VM).
    // It has no DB/Redis dependencies and binds to 127.0.0.1 only.
    // Shutdown is handled in sullaEnd().
    try {
      const { getTerminalServer } = await import('@pkg/main/terminalServer');

      await getTerminalServer().start();
      console.log(`[Background] Terminal WebSocket server started on ${ loopbackOrigin('ws', 6108) }`);
    } catch (error) {
      console.error('[Background] Failed to start terminal WebSocket server:', error);
    }

    // Sweep old browser screenshots. Non-blocking, best-effort.
    void import('@pkg/agent/tools/browser/screenshot_store')
      .then(m => m.pruneOldScreenshots())
      .catch(err => console.warn('[Background] Screenshot prune failed:', err));

    // Register ModelProviderService IPC handlers before any window loads.
    // Lifecycle-gated state loading happens later, but the UI needs to query
    // state immediately — and instantiateSullaStart() only runs after the VM boots,
    // which may be blocked on container readiness.
    try {
      const { getModelProviderService } = await import('@pkg/agent/services/ModelProviderService');
      getModelProviderService().registerIpc();
      console.log('[Background] ModelProviderService IPC handlers registered (early)');
    } catch (error) {
      console.error('[Background] Failed to register ModelProviderService IPC:', error);
    }

    // Cache it in settings on first request
    ipc.handle('get-user-data-path', async() => {
      return app.getPath('userData');
    });

    // Onboarding card visibility — each card hides only when its specific
    // onboarding-created file exists (NOT the general identity files that
    // daily workflows create independently).
    const goalsOnboardingPath = path.join(paths.sullaHome, 'identity', 'onboarding.md');
    const businessOnboardingPath = path.join(paths.sullaHome, 'identity', 'business', 'onboarding.md');

    ipc.handle('check-goals-onboarding', async() => {
      return !fs.existsSync(goalsOnboardingPath);
    });
    ipc.handle('check-business-onboarding', async() => {
      return !fs.existsSync(businessOnboardingPath);
    });

    // Legacy — still used by some code paths to mark first chat complete
    const firstChatLockPath = path.join(app.getPath('userData'), 'first-chat.lock');
    ipc.handle('check-first-chat', async() => {
      return !fs.existsSync(firstChatLockPath);
    });
    ipc.handle('mark-first-chat-complete', async() => {
      try {
        fs.writeFileSync(firstChatLockPath, new Date().toISOString(), 'utf-8');
      } catch (err) {
        console.error('[Sulla] Failed to write first-chat lock:', err);
      }
    });

    // Handle app quit requests from the UI
    ipc.handle('app-quit', async() => {
      console.log('[Sulla] Quitting application...');
      const firstRunWindow = window.getWindow('first-run');
      if (firstRunWindow) {
        firstRunWindow.setClosable(true);
        firstRunWindow.close();
      }

      app.quit();
    });
  }
}
