// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const FILES_OPEN_CALL_BUDGET_MS = 10_500;

/** One deadline and abort signal shared by every awaited stage of files/open. */
export class FilesOpenCallBudget {
  private readonly deadlineAt:number;
  private readonly controller = new AbortController();
  private readonly timeoutPromise:Promise<never>;
  private timer:ReturnType<typeof setTimeout> | undefined;
  private activeStage = 'completing the request';
  private expired = false;

  constructor(readonly timeoutMs = FILES_OPEN_CALL_BUDGET_MS) {
    this.deadlineAt = Date.now() + timeoutMs;
    this.timeoutPromise = new Promise((_, reject) => {
      this.timer = setTimeout(() => {
        this.expired = true;
        this.controller.abort();
        reject(this.timeoutError(this.activeStage));
      }, timeoutMs);
    });
  }

  get signal():AbortSignal {
    return this.controller.signal;
  }

  remainingMs():number {
    return Math.max(0, this.deadlineAt - Date.now());
  }

  async run<T>(stage:string, operation:() => Promise<T>):Promise<T> {
    if (this.expired || this.remainingMs() <= 0) {
      this.expired = true;
      this.controller.abort();
      throw this.timeoutError(stage);
    }
    this.activeStage = stage;
    try {
      return await Promise.race([Promise.resolve().then(operation), this.timeoutPromise]);
    } catch (error) {
      if (this.expired) throw this.timeoutError(this.activeStage);
      throw error;
    }
  }

  dispose():void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private timeoutError(stage:string):Error {
    return new Error(`Sulla Files open exceeded its ${ this.timeoutMs }ms response budget while ${ stage }.`);
  }
}
