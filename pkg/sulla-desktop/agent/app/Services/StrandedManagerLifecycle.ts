// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface StrandedSchedulerControl { start(): void; stop(): void }
export interface ApplicationQuitEvents { once(event: 'before-quit' | 'will-quit', listener: () => void): unknown }

/** Owns the production scheduler from application startup through Electron shutdown. */
export class StrandedManagerLifecycle {
  private started = false;

  constructor(private readonly scheduler: StrandedSchedulerControl, private readonly app: ApplicationQuitEvents) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduler.start();
    const stop = () => this.stop();
    this.app.once('before-quit', stop);
    this.app.once('will-quit', stop);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.scheduler.stop();
  }
}
