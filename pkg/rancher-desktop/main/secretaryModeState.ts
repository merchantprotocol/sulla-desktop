/*
  Secretary Mode state — tiny main-process cache of whether Secretary
  Mode is currently listening, and which tab owns that session.

  The renderer (pages/SecretaryMode.vue) pushes updates here via the
  `secretary-mode:state-changed` IPC message whenever isListening flips
  or the tab unmounts. Agent tools (sulla secretary/status) and any
  main-process consumer read via getSecretaryModeState().

  No persistence — the state is ephemeral. If the app restarts, there
  is no active session to remember.
*/
import { ipcMain } from 'electron';

export interface SecretaryModeState {
  listening: boolean;
  tabId:     string | null;
}

let cache: SecretaryModeState = { listening: false, tabId: null };

export function getSecretaryModeState(): SecretaryModeState {
  return { ...cache };
}

export function initSecretaryModeStateIpc(): void {
  ipcMain.on('secretary-mode:state-changed', (_event, payload: Partial<SecretaryModeState>) => {
    cache = {
      listening: !!payload?.listening,
      tabId:     typeof payload?.tabId === 'string' ? payload.tabId : null,
    };
  });
}
