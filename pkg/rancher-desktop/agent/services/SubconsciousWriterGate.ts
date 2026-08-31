// SubconsciousWriterGate.ts
//
// Process-wide concurrency gate for post-turn subconscious writers.
//
// SubconsciousMiddleware.runSubconsciousObservationWriters fires 8
// fire-and-forget, LLM-calling background agents after EVERY completed
// conversation (chat, mobile-relay, Heartbeat cycles, PM-automation worker
// turns all funnel through the same backend process). With no throttle,
// each conversation's writers fire in parallel with every other concurrent
// conversation's writers — when several conversations complete close
// together (PM automation running at concurrency 5, Heartbeat, multiple
// chat/mobile sessions), the fan-out multiplies unbounded and can saturate
// the shared LLM provider concurrency or the local Postgres pool, stalling
// the primary interactive turn's own model call on any channel.
//
// This gate does not skip or time-box any writer — every writer still runs
// to completion with a model in the loop. It only bounds how many run
// concurrently process-wide, queuing the rest in arrival order.
const MAX_CONCURRENT_WRITERS = 3;

let active = 0;
const waiters: (() => void)[] = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT_WRITERS) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waiters.push(() => {
      active++;
      resolve();
    });
  });
}

function release(): void {
  active--;
  const next = waiters.shift();
  if (next) next();
}

/** Runs `run` once a concurrency slot is free, then releases the slot. */
export async function runThroughWriterGate<T>(run: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await run();
  } finally {
    release();
  }
}

/** Test-only: reset gate state between test cases. */
export function _resetWriterGateForTests(): void {
  active = 0;
  waiters.length = 0;
}

/** Test-only: inspect current gate occupancy. */
export function _writerGateStateForTests(): { active: number; waiting: number } {
  return { active, waiting: waiters.length };
}
