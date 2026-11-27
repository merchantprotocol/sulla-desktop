// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Drives edge scrolling even when Chromium stops sending pointermove. */
export class TabDragAutoScroll {
  private frame?: number;
  private step?:  () => boolean;

  constructor(private readonly clock: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'>) {}

  start(step: () => boolean): void {
    this.step = step;
    if (this.frame === undefined) this.frame = this.clock.requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.frame !== undefined) this.clock.cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.step = undefined;
  }

  private readonly tick = () => {
    this.frame = undefined;
    if (this.step?.() && this.step) this.frame = this.clock.requestAnimationFrame(this.tick);
    else this.step = undefined;
  };
}
