// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// "Sulla" is a trademark. See TRADEMARK.md.

import { onBeforeUnmount, onMounted, ref } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export interface DebugErrorRecord {
  timestamp: string;
  process: string;
  source: string;
  message: string;
  stack: string;
}

/** Owns the debug-error list and the window listeners that feed it. */
export class DebugErrorsController {
  readonly errors = ref<DebugErrorRecord[]>([]);

  readonly onReported = (_event: unknown, record: DebugErrorRecord) => { this.errors.value = [record, ...this.errors.value].slice(0, 100) };
  readonly onWindowError = (event: ErrorEvent) => ipcRenderer.send('debug:report', 'window.onerror', { message: event.message, stack: event.error?.stack });
  readonly onUnhandledRejection = (event: PromiseRejectionEvent) => {
    const error = event.reason;
    ipcRenderer.send('debug:report', 'unhandledrejection', { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : '' });
  };
  readonly dismiss = (index: number) => this.errors.value.splice(index, 1);
  readonly clear = () => { this.errors.value = [] };

  start(): void {
    ipcRenderer.on('debug:error' as any, this.onReported as any);
    void ipcRenderer.invoke('debug:errors:list' as any).then((records: DebugErrorRecord[]) => { this.errors.value = records }).catch(error => {
      ipcRenderer.send('debug:report' as any, 'debug-overlay:initial-errors', { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : '' });
    });
    window.addEventListener('error', this.onWindowError);
    window.addEventListener('unhandledrejection', this.onUnhandledRejection);
  }

  stop(): void {
    ipcRenderer.removeListener('debug:error' as any, this.onReported as any);
    window.removeEventListener('error', this.onWindowError);
    window.removeEventListener('unhandledrejection', this.onUnhandledRejection);
  }
}

export function useDebugErrors() {
  const controller = new DebugErrorsController();
  onMounted(() => controller.start());
  onBeforeUnmount(() => controller.stop());
  return { errors: controller.errors, dismiss: controller.dismiss, clear: controller.clear };
}
