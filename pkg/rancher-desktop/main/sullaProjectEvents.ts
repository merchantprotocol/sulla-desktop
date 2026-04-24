/**
 * Sulla project IPC handlers.
 *
 *   projects-list → ProjectRegistry.listProjects()
 *
 * Surfaces the user's projects (directory-backed under ~/sulla/projects/,
 * plus any DB-tracked ones) as a flat list. Used by the chat composer's
 * `@` mention autocomplete so users can reference their own projects
 * without touching the filesystem directly.
 */
import { ipcMainProxy } from '@pkg/main/ipcMain';

import { ProjectRegistry } from '@pkg/agent/database/registry/ProjectRegistry';

export function initSullaProjectEvents(): void {
  ipcMainProxy.handle('projects-list', async() => {
    try {
      return await ProjectRegistry.getInstance().listProjects();
    } catch (err) {
      console.error('[Sulla] projects-list failed:', err);
      return [];
    }
  });
}
