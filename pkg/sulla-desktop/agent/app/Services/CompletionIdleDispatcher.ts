// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export type CompletionDispatch = (channel: string, threadId: string) => void;

export class CompletionIdleDispatcher {
  private dispatcher?: CompletionDispatch;

  register(dispatcher: CompletionDispatch): void {
    this.dispatcher = dispatcher;
  }

  dispatch(channel: string, threadId: string): void {
    this.dispatcher?.(channel, threadId);
  }

  clear(): void {
    this.dispatcher = undefined;
  }
}
