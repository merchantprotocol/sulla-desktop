/**
 * Reflex prewarm — use Reflex's guesses (including ones far below the act
 * threshold) to warm what the model will probably touch before it asks:
 * the tool's module, the docker daemon, the Projects tables.
 *
 * Hard rule: this never changes the tool set the model is given. It only
 * does cheap, read-only work whose sole effect is that the model's own call
 * is faster. A wrong guess costs one short warm-up, deduped across turns and
 * keystrokes, and is abandoned as soon as the turn ends.
 */

import { toolRegistry } from '../tools/registry';

import { REFLEX_NONE, type ReflexPrediction } from './ReflexEngine';

/** Warm any candidate at/above this, far below the act and hint thresholds. */
export const DEFAULT_REFLEX_PREWARM_FLOOR = 0.2;
const MAX_PREWARM_TOOLS = 3;
/** A category warm-up is reused for this long before it runs again. */
const CATEGORY_WARM_TTL_MS = 60_000;

export interface ReflexPrewarmPlan {
  tools:      string[];
  categories: string[];
}

export interface ReflexPrewarmHandle {
  plan:    ReflexPrewarmPlan;
  status:  'off' | 'running' | 'done' | 'aborted';
  /** Warm-ups that actually ran for this handle (cached ones are skipped) */
  warmed:  string[];
  ms:      number;
  done:    Promise<void>;
}

type Warmer = () => Promise<unknown>;

/**
 * Read-only, bounded warm-ups per tool category. Categories without an entry
 * still get their tool modules loaded. Never add anything with side effects
 * the human could see (mic, camera, tabs, notifications).
 */
const CATEGORY_WARMERS: Record<string, Warmer> = {
  docker: async() => {
    const { runCommand } = await import('../tools/util/CommandRunner');
    await runCommand('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 4000, maxOutputChars: 200 });
  },
  project: async() => {
    const { getProjectsApplicationService } = await import('../projects/application/ProjectsApplicationService');
    const projects = getProjectsApplicationService();
    await projects.ready();
    await projects.listProjects({ limit: 20 });
  },
};

const warmedAt = new Map<string, number>();
const inflight = new Map<string, Promise<void>>();

/** Which tools/categories a prediction points at. Pure. */
export function planReflexPrewarm(
  prediction: ReflexPrediction,
  categoryOf: (toolName: string) => string | undefined,
  floor = DEFAULT_REFLEX_PREWARM_FLOOR,
): ReflexPrewarmPlan {
  if (prediction.toolName === REFLEX_NONE) return { tools: [], categories: [] };
  const tools: string[] = [];
  for (const c of prediction.candidates) {
    if (c.confidence < floor || c.toolName === REFLEX_NONE || tools.includes(c.toolName)) continue;
    tools.push(c.toolName);
    if (tools.length >= MAX_PREWARM_TOOLS) break;
  }
  const categories = [...new Set(tools.map(categoryOf).filter((c): c is string => !!c))];
  return { tools, categories };
}

/** Run `warm` once per key per ttl; concurrent callers share the in-flight run. Returns true if it ran now. */
async function warmOnce(key: string, ttlMs: number, warm: Warmer): Promise<boolean> {
  const at = warmedAt.get(key);
  if (at !== undefined && Date.now() - at < ttlMs) return false;
  const running = inflight.get(key);
  if (running) {
    await running;
    return false;
  }
  const run = (async() => {
    try {
      await warm();
      warmedAt.set(key, Date.now());
    } catch (err) {
      // A failed warm-up is harmless; remember it anyway so a broken daemon isn't retried every keystroke.
      warmedAt.set(key, Date.now());
      console.debug(`[ReflexPrewarm] ${ key } failed:`, err instanceof Error ? err.message : err);
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, run);
  await run;
  return true;
}

/**
 * Start warming for a prediction in the background. Never throws and never
 * blocks the caller. Each warm-up is read-only and time-bounded; aborting
 * `signal` (the turn is over) skips any that have not started.
 */
export function startReflexPrewarm(
  prediction: ReflexPrediction,
  categoryOf: (toolName: string) => string | undefined,
  opts: { signal?: AbortSignal; enabled?: boolean; floor?: number } = {},
): ReflexPrewarmHandle {
  const plan = planReflexPrewarm(prediction, categoryOf, opts.floor);
  const handle: ReflexPrewarmHandle = { plan, status: 'off', warmed: [], ms: 0, done: Promise.resolve() };
  if (opts.enabled === false || (!plan.tools.length && !plan.categories.length)) return handle;

  handle.status = 'running';
  const started = Date.now();
  const steps: [string, number, Warmer][] = [
    ...plan.tools.map((t): [string, number, Warmer] => [`tool:${ t }`, Infinity, () => toolRegistry.createTool(t)]),
    ...plan.categories.filter(c => CATEGORY_WARMERS[c]).map((c): [string, number, Warmer] => [`category:${ c }`, CATEGORY_WARM_TTL_MS, CATEGORY_WARMERS[c]]),
  ];
  handle.done = (async() => {
    await Promise.all(steps.map(async([key, ttl, warm]) => {
      if (opts.signal?.aborted) return;
      if (await warmOnce(key, ttl, warm)) handle.warmed.push(key);
    }));
    handle.ms = Date.now() - started;
    handle.status = opts.signal?.aborted ? 'aborted' : 'done';
  })().catch(() => { handle.status = 'done' });
  return handle;
}

/** Compact perf.log field, e.g. `predicted=docker prewarm=done:category:docker(412ms)`. */
export function formatPrewarmTiming(handle: ReflexPrewarmHandle | null): string {
  if (!handle) return 'predicted=none prewarm=off';
  const predicted = handle.plan.categories.join('+') || 'none';
  const warmed = handle.warmed.length ? `:${ handle.warmed.join('+') }` : '';
  const ms = handle.status === 'done' || handle.status === 'aborted' ? `(${ handle.ms }ms)` : '';
  return `predicted=${ predicted } prewarm=${ handle.status }${ warmed }${ ms }`;
}

/** Test hook: forget what has been warmed. */
export function resetReflexPrewarmCache(): void {
  warmedAt.clear();
  inflight.clear();
}
