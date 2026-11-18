// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: undefined,
  screen: undefined,
  ipcMain: undefined,
  BrowserWindow: undefined,
  WebContentsView: undefined,
}));

describe('renderer-safe window utility imports', () => {
  it('imports agent window and persistence modules without main-process Electron APIs', async() => {
    await expect(import('./agentWindows')).resolves.toBeDefined();
    await expect(import('./AgentWindowPersistence')).resolves.toBeDefined();
  });
});
