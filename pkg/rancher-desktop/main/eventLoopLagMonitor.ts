import { monitorEventLoopDelay } from 'perf_hooks';

import Logging from '@pkg/utils/logging';

const perf = Logging.perf;

/** Only report windows where the main thread actually stalled. */
const REPORT_THRESHOLD_MS = 100;
const WINDOW_MS = 60_000;

let started = false;

/**
 * Logs main-process event-loop delay to perf.log once a minute when the
 * worst stall crossed REPORT_THRESHOLD_MS. Tab switches, IPC and agent
 * stream parsing all share this thread, so a stall here shows up directly
 * as slow tab swaps. Quiet minutes log nothing.
 */
export function startEventLoopLagMonitor(): void {
  if (started) return;
  started = true;

  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  const timer = setInterval(() => {
    const maxMs = histogram.max / 1e6;
    if (maxMs >= REPORT_THRESHOLD_MS) {
      const p50 = (histogram.percentile(50) / 1e6).toFixed(0);
      const p99 = (histogram.percentile(99) / 1e6).toFixed(0);
      perf.log(`[EventLoopLag] windowMs=${ WINDOW_MS } p50Ms=${ p50 } p99Ms=${ p99 } maxMs=${ maxMs.toFixed(0) }`);
    }
    histogram.reset();
  }, WINDOW_MS);
  timer.unref?.();
}
