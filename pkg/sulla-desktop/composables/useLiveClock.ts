// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * useLiveClock — shared 1 Hz wall-clock for live elapsed counters.
 *
 * Every caller shares the same `now` ref so thirty running routine
 * cards don't mean thirty setInterval timers. The interval is lazily
 * started on first subscriber and stopped when the last one unmounts,
 * so idle canvases don't burn a timer they'll never read.
 */

import { onBeforeUnmount, ref, type Ref } from 'vue';

/** One window-wide 1 Hz clock shared by every live elapsed counter. */
export class LiveClock {
  private static instance: LiveClock | null = null;

  /** The single clock every component in this window shares. */
  static shared(): LiveClock {
    if (!LiveClock.instance) LiveClock.instance = new LiveClock();

    return LiveClock.instance;
  }

  readonly now: Ref<number> = ref(Date.now());
  private timer: ReturnType<typeof setInterval> | null = null;
  private subscribers = 0;

  /** Count one subscriber and make sure the timer runs. */
  subscribe(): void {
    this.subscribers += 1;
    this.start();
  }

  /** Drop one subscriber; stop the timer when nobody is left. */
  unsubscribe(): void {
    this.subscribers -= 1;
    if (this.subscribers <= 0) {
      this.subscribers = 0;
      this.stop();
    }
  }

  private start(): void {
    if (this.timer) return;
    this.now.value = Date.now();
    this.timer = setInterval(() => {
      this.now.value = Date.now();
    }, 1000);
  }

  private stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

export function useLiveClock() {
  const clock = LiveClock.shared();

  clock.subscribe();
  onBeforeUnmount(() => clock.unsubscribe());

  return clock.now;
}
