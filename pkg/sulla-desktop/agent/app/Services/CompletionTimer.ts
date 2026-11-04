// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface CompletionTimerHandle {
  unref(): void;
}

export interface CompletionTimer {
  schedule(callback: () => void, delayMs: number): CompletionTimerHandle;
  cancel(handle: CompletionTimerHandle): void;
}

export class SystemCompletionTimer implements CompletionTimer {
  schedule(callback: () => void, delayMs: number): CompletionTimerHandle {
    return setTimeout(callback, delayMs);
  }

  cancel(handle: CompletionTimerHandle): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}
