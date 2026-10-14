/**
 * Error Reporter — submits error reports to the Sulla error-reports Cloudflare Worker.
 *
 * Used by:
 *  - KubernetesError dialog (via IPC from renderer)
 *  - Native Electron error dialogs (from main process)
 *  - Global unhandledRejection / uncaughtException handlers
 */
import os from 'os';

import Electron from 'electron';

import { getSettings } from '@pkg/config/settingsImpl';
import { CLOUD_API_BASE } from '@pkg/main/cloud/cloudEndpoints';
import { getInstallId } from '@pkg/main/installId';

const ERROR_REPORT_URL = 'https://error-reports.merchantprotocol.com';
const MAX_ERROR_MESSAGE_LENGTH = 1_024;
const MAX_STACK_TRACE_LENGTH = 8 * 1_024;

// Client-side flood guard: if a process gets stuck in a tight loop emitting the
// same rejection (e.g. a `.once()` listener firing repeatedly), we'd otherwise
// hammer the worker thousands of times in seconds. Keep the first N submissions
// per signature within a window, then drop the rest until the window resets.
const DEDUPE_WINDOW_MS = 60_000;
const DEDUPE_MAX_PER_WINDOW = 3;
const recentSubmissions = new Map<string, { firstSeenAt: number; count: number; suppressed: number }>();

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = '';

  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');

    if (bytes + characterBytes > maxBytes) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }

  return result;
}

function dedupeSignature(report: ErrorReportPayload): string {
  const firstStackFrame = (report.stack_trace || '').split('\n').find(line => line.trim().startsWith('at ')) || '';
  return `${ report.error_type }|${ report.error_message }|${ firstStackFrame.trim() }`;
}

function shouldSuppress(report: ErrorReportPayload): boolean {
  const sig = dedupeSignature(report);
  const now = Date.now();
  const entry = recentSubmissions.get(sig);

  if (!entry || now - entry.firstSeenAt > DEDUPE_WINDOW_MS) {
    recentSubmissions.set(sig, { firstSeenAt: now, count: 1, suppressed: 0 });
    return false;
  }

  entry.count += 1;
  if (entry.count <= DEDUPE_MAX_PER_WINDOW) {
    return false;
  }

  entry.suppressed += 1;
  if (entry.suppressed === 1 || entry.suppressed % 100 === 0) {
    console.warn(`[ErrorReporter] Suppressed ${ entry.suppressed } duplicate report(s) for: ${ sig.slice(0, 200) }`);
  }
  return true;
}

export interface ErrorReportPayload {
  error_type:    string;
  error_message: string;
  stack_trace?:  string;
  app_version?:  string;
  os_platform?:  string;
  os_version?:   string;
  user_context?: string;
  notify_email?: string;
}

/**
 * Submit an error report to the Cloudflare worker.
 * Never throws — silently fails if the network is down.
 */
export async function submitErrorReport(report: ErrorReportPayload): Promise<{ success: boolean; action?: string; issue_number?: number }> {
  const payload: ErrorReportPayload = {
    error_type:    report.error_type || 'unknown',
    error_message: report.error_message || 'No error message provided',
    stack_trace:   report.stack_trace || '',
    app_version:   report.app_version || getAppVersion(),
    os_platform:   report.os_platform || process.platform,
    os_version:    report.os_version || os.release(),
    user_context:  report.user_context || '',
  };

  if (report.notify_email) {
    payload.notify_email = report.notify_email;
  }

  if (shouldSuppress(payload)) {
    return { success: false, action: 'suppressed_duplicate' };
  }

  if (!getSettings().application.telemetry.enabled) {
    return { success: false, action: 'telemetry_disabled' };
  }

  void submitCloudError(payload);

  try {
    const response = await Electron.net.fetch(`${ ERROR_REPORT_URL }/`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    if (response.ok) {
      const data = await response.json() as { success: boolean; action?: string; issue_number?: number };

      return data;
    }

    console.error(`[ErrorReporter] HTTP ${ response.status }: ${ response.statusText }`);

    return { success: false };
  } catch (err) {
    // Silently fail — never crash the app over error reporting
    console.error('[ErrorReporter] Failed to submit report:', err);

    return { success: false };
  }
}

async function submitCloudError(report: ErrorReportPayload): Promise<void> {
  try {
    await Electron.net.fetch(`${ CLOUD_API_BASE }/desktop/errors`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        installId:    getInstallId(Electron.app.getPath('userData')),
        appVersion:   report.app_version || getAppVersion(),
        platform:     report.os_platform || process.platform,
        arch:         process.arch,
        osVersion:    report.os_version || os.release(),
        errorType:    report.error_type,
        errorMessage: truncateUtf8(report.error_message, MAX_ERROR_MESSAGE_LENGTH),
        stackTrace:   truncateUtf8(report.stack_trace || '', MAX_STACK_TRACE_LENGTH),
        context:      report.user_context || '',
      }),
    });
  } catch {
    // The Cloud copy is fire-and-forget and must never affect error handling.
  }
}

/**
 * Report an error from a caught exception with contextual information.
 */
export async function reportError(
  error: Error | string,
  context: string,
  options?: { notifyEmail?: string },
): Promise<{ success: boolean }> {
  const err = typeof error === 'string' ? new Error(error) : error;

  return submitErrorReport({
    error_type:    err.name || 'Error',
    error_message: err.message,
    stack_trace:   err.stack || '',
    user_context:  context,
    notify_email:  options?.notifyEmail,
  });
}

/**
 * Show a native Electron error dialog with a "Send Report" option.
 * Returns true if the user clicked "Send Report" and the report was submitted.
 */
export async function showErrorDialogWithReport(
  title: string,
  message: string,
  context: string,
  parentWindow?: Electron.BrowserWindow | null,
): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type:      'error',
    title,
    message,
    buttons:   ['Send Report', 'Close'],
    defaultId: 0,
    cancelId:  1,
  };

  const result = parentWindow
    ? await Electron.dialog.showMessageBox(parentWindow, options)
    : await Electron.dialog.showMessageBox(options);

  if (result.response === 0) {
    const report = await submitErrorReport({
      error_type:    'app_error',
      error_message: `${ title }: ${ message }`,
      user_context:  context,
    });

    return report.success;
  }

  return false;
}

function getAppVersion(): string {
  try {
    return Electron.app.getVersion();
  } catch {
    return 'unknown';
  }
}
