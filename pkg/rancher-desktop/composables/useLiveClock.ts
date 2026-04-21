/**
 * useLiveClock — shared 1 Hz wall-clock for live elapsed counters.
 *
 * Every caller shares the same `now` ref so thirty running routine
 * cards don't mean thirty setInterval timers. The interval is lazily
 * started on first subscriber and stopped when the last one unmounts,
 * so idle canvases don't burn a timer they'll never read.
 */

import { onBeforeUnmount, ref } from 'vue';

const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
let subscribers = 0;

function start() {
  if (timer) return;
  now.value = Date.now();
  timer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
}

function stop() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export function useLiveClock() {
  subscribers += 1;
  start();

  onBeforeUnmount(() => {
    subscribers -= 1;
    if (subscribers <= 0) {
      subscribers = 0;
      stop();
    }
  });

  return now;
}
