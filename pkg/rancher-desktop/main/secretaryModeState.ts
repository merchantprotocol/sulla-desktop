/*
  Secretary Mode state — tiny main-process cache of whether Secretary
  Mode is currently listening, and which tab owns that session.

  The renderer (pages/SecretaryMode.vue) pushes updates here via the
  `secretary-mode:state-changed` IPC message whenever isListening flips
  or the tab unmounts. Agent tools (sulla secretary/status) and any
  main-process consumer read via getSecretaryModeState().

  No persistence — the state is ephemeral. If the app restarts, there
  is no active session to remember.

  Meeting notes are the exception: the renderer saves each session's
  transcript + notes as markdown under <sulla home>/meetings/ via
  `secretary-mode:save-notes`, so they survive closing the tab.
*/
import fs from 'fs';
import path from 'path';

import { ipcMain, shell } from 'electron';

import { resolveSullaHomeDir } from '@pkg/agent/utils/sullaPaths';

export interface SecretaryModeState {
  listening: boolean;
  tabId:     string | null;
}

let cache: SecretaryModeState = { listening: false, tabId: null };

export function getSecretaryModeState(): SecretaryModeState {
  return { ...cache };
}

export function getMeetingNotesDir(): string {
  return path.join(resolveSullaHomeDir(), 'meetings');
}

/**
 * Resolve where a session's notes go. Re-saves pass back the path returned by
 * the first save; anything outside the meetings dir is ignored.
 */
export function resolveMeetingNotesPath(fileName: string, existingPath?: string | null): string {
  const dir = getMeetingNotesDir();

  if (existingPath) {
    const resolved = path.resolve(existingPath);
    if (path.dirname(resolved) === dir && resolved.endsWith('.md')) return resolved;
  }

  const safeName = path.basename(fileName).replace(/[^\w.-]+/g, '-');

  return path.join(dir, safeName.endsWith('.md') ? safeName : `${ safeName }.md`);
}

export function initSecretaryModeStateIpc(): void {
  ipcMain.on('secretary-mode:state-changed', (_event, payload: Partial<SecretaryModeState>) => {
    cache = {
      listening: !!payload?.listening,
      tabId:     typeof payload?.tabId === 'string' ? payload.tabId : null,
    };
  });

  ipcMain.handle('secretary-mode:save-notes', async(_event, payload: { fileName: string; markdown: string; path?: string | null }) => {
    try {
      const target = resolveMeetingNotesPath(payload.fileName, payload.path);

      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, payload.markdown, 'utf8');

      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('secretary-mode:reveal-notes', (_event, notesPath: string) => {
    const resolved = path.resolve(notesPath);
    if (path.dirname(resolved) !== getMeetingNotesDir()) return { ok: false };
    shell.showItemInFolder(resolved);

    return { ok: true };
  });
}
