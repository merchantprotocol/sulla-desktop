/**
 * Device-targeted Use Case installs — the other half of the Cloud web app's
 * Use Cases "Where" picker. When someone picks this Mac as an install
 * target, Sulla Cloud queues a row; this desktop polls for its own pending
 * rows, runs them through the existing marketplace installer, and reports
 * real progress back. Queued while offline; picked up on the next poll
 * after the signed-in heartbeat resumes.
 *
 * "Installed" means what it means everywhere else in Sulla Desktop: the
 * listing is registered (installTemplateWithDependencies). A recipe's
 * Docker containers still need the existing separate "Make active" step —
 * this does not start them.
 */

import os from 'os';
import { BrowserWindow, dialog } from 'electron';

import { cloudRequest, isCloudSignedIn } from '../../cloud/cloudFetch';
import { getCloudPreferences } from '../../cloud/cloudSettings';
import { getDesktopDeviceId } from '../../deviceIdentity';
import { installTemplateWithDependencies } from '../install';

import { getProductionVersion } from '@pkg/utils/version';
import Logging from '@pkg/utils/logging';

const console = Logging.background;

const POLL_INTERVAL_MS = 20_000;

interface PendingInstall {
  id: string;
  templateId: string;
}

async function confirmInstall(install: PendingInstall): Promise<boolean> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  const options = { type: 'question' as const, buttons: ['Deny', 'Install'], defaultId: 0, cancelId: 0, noLink: true,
    title: 'Install this Use Case?', message: 'Sulla Cloud requested a Use Case install on this Desktop.',
    detail: `Use Case: ${install.templateId}\n\nInstall only if you made this request in Sulla Cloud.` };
  const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return result.response === 1;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let polling = false;

async function fetchPending(deviceId: string): Promise<PendingInstall[]> {
  const res = await cloudRequest('GET', `/cloud-usecase-installs/v1/device-installs/pending?deviceId=${ encodeURIComponent(deviceId) }`);
  if (!res.ok) return [];
  const body = await res.json().catch(() => null) as { data?: { installs?: unknown } } | null;
  const installs = body?.data?.installs;
  if (!Array.isArray(installs)) return [];
  return installs
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && typeof item.id === 'string' && typeof item.templateId === 'string')
    .map(item => ({ id: item.id as string, templateId: item.templateId as string }));
}

/** The error goes to Cloud: keep local home paths out of it. */
function cloudSafeError(message: string): string {
  const home = os.homedir();
  return (home ? message.split(home).join('~') : message).slice(0, 500);
}

async function report(id: string, status: 'active' | 'failed', error?: string): Promise<void> {
  try {
    await cloudRequest('POST', `/cloud-usecase-installs/v1/device-installs/${ encodeURIComponent(id) }/report`, {
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status, error: error === undefined ? undefined : cloudSafeError(error), appVersion: getProductionVersion() }),
    });
  } catch (err) {
    console.log(`[DeviceInstallSync] failed to report ${ id }: ${ err }`);
  }
}

async function runPendingInstalls(): Promise<void> {
  const prefs = await getCloudPreferences();
  if (polling || !prefs.enabled || !prefs.useCases || !(await isCloudSignedIn())) return;
  polling = true;
  try {
    const deviceId = await getDesktopDeviceId();
    const pending = await fetchPending(deviceId);
    for (const install of pending) {
      try {
        if (!await confirmInstall(install)) {
          await report(install.id, 'failed', 'Declined on the target Desktop');
          continue;
        }
        await installTemplateWithDependencies(install.templateId);
        await report(install.id, 'active');
        console.log(`[DeviceInstallSync] installed ${ install.templateId }`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await report(install.id, 'failed', message);
        console.log(`[DeviceInstallSync] install failed for ${ install.templateId }: ${ message }`);
      }
    }
  } catch (err) {
    console.log(`[DeviceInstallSync] poll failed: ${ err }`);
  } finally {
    polling = false;
  }
}

export const DeviceInstallSync = {
  /** Idempotent — safe to call repeatedly. */
  start(): void {
    if (pollTimer) return;
    void runPendingInstalls();
    pollTimer = setInterval(() => { void runPendingInstalls() }, POLL_INTERVAL_MS);
  },

  stop(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  },
};
