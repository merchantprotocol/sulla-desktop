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

export function useDebugErrors() {
  const errors = ref<DebugErrorRecord[]>([]);
  const onReported = (_event: unknown, record: DebugErrorRecord) => { errors.value = [record, ...errors.value].slice(0, 100) };
  const onWindowError = (event: ErrorEvent) => ipcRenderer.send('debug:report', 'window.onerror', { message: event.message, stack: event.error?.stack });
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    const error = event.reason;
    ipcRenderer.send('debug:report', 'unhandledrejection', { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : '' });
  };
  const dismiss = (index: number) => errors.value.splice(index, 1);
  const clear = () => { errors.value = [] };

  onMounted(() => {
    ipcRenderer.on('debug:error' as any, onReported as any);
    void ipcRenderer.invoke('debug:errors:list' as any).then((records: DebugErrorRecord[]) => { errors.value = records }).catch(error => {
      ipcRenderer.send('debug:report' as any, 'debug-overlay:initial-errors', { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : '' });
    });
    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
  });
  onBeforeUnmount(() => {
    ipcRenderer.removeListener('debug:error' as any, onReported as any);
    window.removeEventListener('error', onWindowError);
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
  });
  return { errors, dismiss, clear };
}
