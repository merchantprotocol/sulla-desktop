import { ipcRenderer } from '@pkg/utils/ipcRenderer';

/**
 * Open a tab (Passwords, Integrations…) in the main Sulla window. Preferences
 * is its own window, so it asks the main process to forward the request.
 */
export function openMainTab(mode: string): void {
  ipcRenderer.send('preferences/open-main-tab', mode);
}

/** Open the Docker window (containers, images, snapshots). */
export function openDockerWindow(): void {
  ipcRenderer.send('dashboard-open');
}
