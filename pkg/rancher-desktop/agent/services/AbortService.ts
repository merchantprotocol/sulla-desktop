export type AbortCallback = () => void | Promise<void>;

export class AbortService {
  private controller: AbortController;
  private callbacks:  AbortCallback[] = [];

  constructor() {
    this.controller = new AbortController();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  /**
   * Register cleanup logic to be executed when abort() is called.
   * Returns an unregister function.
   */
  onAbort(cb: AbortCallback): () => void {
    this.callbacks.push(cb);
    return () => {
      const idx = this.callbacks.indexOf(cb);
      if (idx >= 0) {
        this.callbacks.splice(idx, 1);
      }
    };
  }

  /**
   * Abort the run and fan-out to all registered callbacks.
   */
  abort(): void {
    if (this.controller.signal.aborted) {
      console.log('[AbortService] Abort already called, ignoring');
      return;
    }

    console.log('[AbortService] Abort called - stopping execution');
    try {
      this.controller.abort();
    } catch {
      // ignore
    }

    const cbs = [...this.callbacks];
    this.callbacks = [];

    for (const cb of cbs) {
      try {
        void cb();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Pause the current graph run and signal that we're waiting for user input.
   * Use this when the agent has completed a cycle and wants to stop.
   */
  pauseForUserInput(reason = 'Cycle complete - waiting for user input'): void {
    console.log(`[AbortService] Pausing for user: ${ reason }`);
    this.abort();
  }
}


/**
 * True when `value` is a real AbortSignal. Duck-typed so jsdom/Node both work.
 */
export function isAbortSignal(value: unknown): value is AbortSignal {
  return !!value &&
    typeof value === 'object' &&
    typeof (value as AbortSignal).aborted === 'boolean' &&
    typeof (value as AbortSignal).addEventListener === 'function' &&
    !('signal' in (value as object) && typeof (value as { signal?: unknown }).signal === 'object');
}

export type AbortSource = AbortService | AbortSignal | undefined | null;

function sourceSignal(src: AbortService | AbortSignal): AbortSignal {
  return src instanceof AbortService ? src.signal : src;
}

/**
 * Combine parent-stop + job-stop into one AbortService.
 *
 * `metadata.options.abort` is typed and consumed as AbortService
 * (`abort.signal`, `throwIfAborted` → `abort?.signal`). The 2026-07-15
 * spawn_agent change stuffed a raw AbortSignal (or AbortSignal.any()) into
 * that slot. Two fallout modes:
 *   1. Parent is AbortService + job is AbortSignal → AbortSignal.any throws
 *      `signals[0] must be AbortSignal` and the sub-agent never starts.
 *   2. Only the job signal is present → raw AbortSignal is assigned, and
 *      throwIfAborted silently no-ops because `signal.signal` is undefined.
 *
 * Returns the sole AbortService when that's the only source (preserves
 * onAbort callbacks). Otherwise wraps any-of-the-signals in a fresh
 * AbortService so consumers keep their contract.
 */
export function combineAborts(...sources: AbortSource[]): AbortService | undefined {
  const services: AbortService[] = [];
  const signals: AbortSignal[] = [];

  for (const src of sources) {
    if (!src) continue;
    if (src instanceof AbortService) {
      services.push(src);
      signals.push(src.signal);
      continue;
    }
    if (isAbortSignal(src)) {
      signals.push(src);
      continue;
    }
    const maybe = (src as { signal?: unknown }).signal;
    if (isAbortSignal(maybe)) {
      signals.push(maybe);
    }
  }

  if (signals.length === 0) return undefined;
  if (signals.length === 1 && services.length === 1) return services[0];

  const combined = new AbortService();
  const fanIn = () => combined.abort();

  for (const sig of signals) {
    if (sig.aborted) {
      combined.abort();

      return combined;
    }
    sig.addEventListener('abort', fanIn, { once: true });
  }

  return combined;
}

/**
 * Portable function to check abort signal and throw AbortError if triggered.
 * Use this to immediately stop execution when abort is detected.
 *
 * @param stateOrSignal State object (with metadata.options.abort) or AbortSignal to check
 * @param message Optional error message
 * @throws AbortError if signal was aborted
 */
export function throwIfAborted(stateOrSignal?: any | AbortSignal, message?: string): void {
  let signal: AbortSignal | undefined;

  // If it's a state object, extract the abort signal from options.abort.
  // Accept either AbortService (the contract) or a raw AbortSignal (legacy
  // spawn_agent assigned those; combineAborts no longer does).
  if (stateOrSignal && typeof stateOrSignal === 'object' && stateOrSignal.metadata) {
    const abort = stateOrSignal.metadata?.options?.abort;
    signal = isAbortSignal(abort) ? abort : abort?.signal;
  } else {
    // Assume it's already an AbortSignal
    signal = stateOrSignal;
  }

  if (signal?.aborted) {
    throw new DOMException(message || 'Operation aborted', 'AbortError');
  }
}
