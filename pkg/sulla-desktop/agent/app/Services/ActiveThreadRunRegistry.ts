// SPDX-License-Identifier: GPL-2.0-or-later

export interface ActiveThreadRun { abort(): void }

/** Shares live chat abort handles with task-stop services without coupling them to the WebSocket dispatcher. */
export class ActiveThreadRunRegistry extends Map<string, ActiveThreadRun> {
  abortThread(threadId: string): void {
    const suffix = `|${ threadId }`;
    for (const [key, run] of this) {
      if (key.endsWith(suffix)) run.abort();
    }
  }
}
