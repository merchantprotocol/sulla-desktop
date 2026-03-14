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

const ERROR_REPORT_URL = 'https://error-reports.merchantprotocol.workers.dev';

export interface ErrorReportPayload {
  error_type: string;
  error_message: string;
  stack_trace?: string;
  app_version?: string;
  os_platform?: string;
  os_version?: string;
  user_context?: string;
  notify_email?: string;
}

/**
 * Submit an error report to the Cloudflare worker.
 * Never throws — silently fails if the network is down.
 */
export async function submitErrorReport(report: ErrorReportPayload): Promise<{ success: boolean; action?: string; issue_number?: number }> {
  const payload: ErrorReportPayload = {
    error_type:   report.error_type || 'unknown',
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
    error_type:   err.name || 'Error',
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
