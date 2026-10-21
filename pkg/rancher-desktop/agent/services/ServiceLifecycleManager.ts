/**
 * ServiceLifecycleManager — dependency-aware, observable startup/shutdown orchestrator.
 *
 * Services register with a name, dependency list, start() and stop() functions.
 * startAll() topologically sorts by dependency and starts in order.
 * stopAll() tears down in reverse order with per-service timeouts.
 *
 * Services may also be marked `requiresVault: true`. Those are gated on
 * setVaultUnlocked(): they stay 'waiting-on-unlock' while the vault is
 * locked, start as soon as it unlocks, and stop (idempotently) when it
 * locks again. Every status transition is observable via 'service:status'
 * so the startup UI can show live per-service progress instead of a
 * single pass/fail signal.
 */

import { EventEmitter } from 'events';

import Logging from '@pkg/utils/logging';

const console = Logging.sulla;

export type LifecycleStatusName = 'pending' | 'starting' | 'waiting-on-unlock' | 'waiting-on-dependency' | 'ready' | 'failed';

export interface LifecycleServiceStatus {
  name:      string;
  status:    LifecycleStatusName;
  reason?:   string;
  since:     number;
  attempts:  number;
}

interface ServiceDefinition {
  name:              string;
  dependencies:      string[];
  start:             () => Promise<void>;
  stop:              () => Promise<void>;
  /** If true, this service is NOT stopped during a 'restart' (e.g. Docker containers). */
  persistOnRestart?: boolean;
  /** If true, this service stays 'waiting-on-unlock' until the vault unlocks. */
  requiresVault?:    boolean;
  /** If false, a failed start is terminal — no automatic retry is scheduled. */
  retry?:            boolean;
}

type StopMode = 'full' | 'restart';

/** Emitted as 'startup:step' for each service during startAll(), alongside the existing logs. */
export interface LifecycleStepEvent {
  name:        string;
  status:      'start' | 'ready' | 'failed' | 'skipped';
  durationMs?: number;
  error?:      string;
  /** True when a failed start will be retried automatically — not a terminal failure. */
  retrying?:   boolean;
}

/** Emitted as 'startup:begin' when startAll() has its order. */
export interface LifecycleBeginEvent {
  order:          string[];
  alreadyStarted: string[];
}

const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000];

export class ServiceLifecycleManager extends EventEmitter {
  private services = new Map<string, ServiceDefinition>();
  private started = new Set<string>();
  private statuses = new Map<string, LifecycleServiceStatus>();
  private starts = new Map<string, Promise<boolean>>();
  private retries = new Map<string, ReturnType<typeof setTimeout>>();
  private vaultUnlocked = false;
  private _shuttingDown = false;
  private _stopMode: StopMode = 'full';
  private _allReady = false;
  private _startOrder: string[] = [];

  /**
   * Register a service with the lifecycle manager.
   * If `alreadyStarted` is true, the service is marked as running and its
   * start() will be skipped during startAll(), but stop() will still be
   * called during stopAll().
   */
  register(
    name: string,
    dependencies: string[],
    start: () => Promise<void>,
    stop: () => Promise<void>,
    opts?: { persistOnRestart?: boolean; alreadyStarted?: boolean; requiresVault?: boolean; retry?: boolean },
  ): void {
    if (this.services.has(name)) {
      console.warn(`[Lifecycle] Service '${ name }' already registered, overwriting`);
    }
    this.services.set(name, {
      name,
      dependencies,
      start,
      stop,
      persistOnRestart: opts?.persistOnRestart ?? false,
      requiresVault:    opts?.requiresVault ?? false,
      retry:            opts?.retry ?? true,
    });
    if (opts?.alreadyStarted) {
      this.started.add(name);
    }
    this.transition(name, opts?.alreadyStarted ? 'ready' : 'pending', opts?.alreadyStarted ? 'Already running' : undefined);
  }

  /** Register a stable definition once across repeated backend generations. */
  registerOnce(
    name: string,
    dependencies: string[],
    start: () => Promise<void>,
    stop: () => Promise<void>,
    opts?: { persistOnRestart?: boolean; alreadyStarted?: boolean; requiresVault?: boolean; retry?: boolean },
  ): void {
    if (this.services.has(name)) return;
    this.register(name, dependencies, start, stop, opts);
  }

  /**
   * Start all registered services in dependency order.
   */
  async startAll(assertCurrent?: () => void): Promise<void> {
    this._shuttingDown = false;
    this._allReady = false;
    assertCurrent?.();
    const order = this.topologicalSort();

    this._startOrder = order;
    console.log(`[Lifecycle] Starting services: ${ order.join(' → ') }`);
    this.emitStep('startup:begin', { order: [...order], alreadyStarted: order.filter(n => this.started.has(n)) });

    for (const name of order) {
      assertCurrent?.();
      if (this._shuttingDown) break;
      await this.startService(name);
      assertCurrent?.();
    }

    this._allReady = true;
    this.emit('all:ready');
    console.log(`[Lifecycle] Startup complete — ${ this.started.size }/${ order.length } services running`);
  }

  /**
   * Immediate vault transition bus entrypoint. Gated services stop on lock
   * and restart on every later unlock.
   */
  async setVaultUnlocked(unlocked: boolean): Promise<void> {
    if (this.vaultUnlocked === unlocked) return;
    this.vaultUnlocked = unlocked;
    console.log(`[Lifecycle] Vault transition: ${ unlocked ? 'unlocked' : 'locked' }`);
    this.emit('vault:state', unlocked);

    const gated = [...this.services.values()].filter(s => s.requiresVault);

    if (!unlocked) {
      for (const svc of gated.reverse()) {
        this.cancelRetry(svc.name);
        if (this.started.delete(svc.name)) {
          await this.stopWithTimeout(svc.name, svc.stop);
        }
        this.transition(svc.name, 'waiting-on-unlock', 'Vault is locked');
      }

      return;
    }

    for (const name of this._startOrder) {
      if (this.services.get(name)?.requiresVault) {
        await this.startService(name);
      }
    }
  }

  serviceStatuses(): LifecycleServiceStatus[] {
    return [...this.statuses.values()].map(value => ({ ...value }));
  }

  waitingOnUnlock(): string[] {
    return this.serviceStatuses().filter(s => s.status === 'waiting-on-unlock').map(s => s.name);
  }

  async retryService(name: string): Promise<boolean> {
    this.cancelRetry(name);

    return this.startService(name);
  }

  private async startService(name: string): Promise<boolean> {
    if (this.started.has(name)) return true;
    const existing = this.starts.get(name);

    if (existing) return existing;

    const svc = this.services.get(name);

    if (!svc || this._shuttingDown) return false;

    if (svc.requiresVault && !this.vaultUnlocked) {
      this.transition(name, 'waiting-on-unlock', 'Vault is locked');

      return false;
    }

    const unmet = svc.dependencies.filter(d => !this.started.has(d));

    if (unmet.length) {
      this.transition(name, 'waiting-on-dependency', `Needs ${ unmet.join(', ') }`);

      return false;
    }

    const run = (async() => {
      const t = Date.now();

      this.transition(name, 'starting');
      this.emitStep('startup:step', { name, status: 'start' });
      try {
        await svc.start();
        this.started.add(name);
        if (this._shuttingDown) {
          if (!(this._stopMode === 'restart' && svc.persistOnRestart)) {
            await this.stopWithTimeout(name, svc.stop);
            this.started.delete(name);
            this.transition(name, 'pending', 'Stopped');
          }

          return false;
        }
        this.transition(name, 'ready');
        this.emitStep('startup:step', { name, status: 'ready', durationMs: Date.now() - t });
        this.emit('service:ready', name);
        for (const dependent of this.services.values()) {
          if (dependent.dependencies.includes(name) && this.statuses.get(dependent.name)?.status === 'waiting-on-dependency') {
            void this.startService(dependent.name);
          }
        }

        return true;
      } catch (err: any) {
        const reason = String(err?.message || err);
        const retrying = svc.retry !== false;

        this.transition(name, 'failed', reason);
        this.emitStep('startup:step', { name, status: 'failed', durationMs: Date.now() - t, error: reason, retrying });
        console.error(`[Lifecycle] '${ name }' failed to start (${ Date.now() - t }ms):`, reason);
        if (svc.retry) this.scheduleRetry(name);

        return false;
      } finally {
        this.starts.delete(name);
      }
    })();

    this.starts.set(name, run);

    return run;
  }

  private scheduleRetry(name: string): void {
    if (this.retries.has(name) || this._shuttingDown) return;
    const attempts = this.statuses.get(name)?.attempts ?? 1;
    const delay = RETRY_DELAYS_MS[Math.min(Math.max(0, attempts - 1), RETRY_DELAYS_MS.length - 1)];
    const timer = setTimeout(() => {
      this.retries.delete(name);
      void this.startService(name);
    }, delay);

    timer.unref?.();
    this.retries.set(name, timer);
    console.log(`[Lifecycle] '${ name }' retry scheduled in ${ delay / 1000 }s`);
  }

  private cancelRetry(name: string): void {
    const timer = this.retries.get(name);

    if (timer) clearTimeout(timer);
    this.retries.delete(name);
  }

  private transition(name: string, status: LifecycleStatusName, reason?: string): void {
    const previous = this.statuses.get(name);

    if (previous?.status === status && previous.reason === reason) return;
    const next: LifecycleServiceStatus = {
      name,
      status,
      reason,
      since:    Date.now(),
      attempts: (previous?.attempts ?? 0) + (status === 'starting' ? 1 : 0),
    };

    this.statuses.set(name, next);
    console.log(`[Lifecycle] Status '${ name }': ${ status }${ reason ? ` — ${ reason }` : '' }`);
    this.emit('service:status', next);
  }

  /**
   * Stop all started services in reverse dependency order.
   */
  async stopAll(mode: StopMode = 'full'): Promise<void> {
    if (this._shuttingDown) return;
    this._shuttingDown = true;
    this._stopMode = mode;
    this._allReady = false;
    this.emit('shutdown:begin', mode);

    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();

    for (const name of [...this._startOrder].reverse()) {
      if (!this.started.has(name)) continue;
      const svc = this.services.get(name);

      if (!svc) continue;
      if (mode === 'restart' && svc.persistOnRestart) continue;
      await this.stopWithTimeout(name, svc.stop);
      this.started.delete(name);
      this.transition(name, 'pending', 'Stopped');
      this.emit('service:stopped', name);
    }
  }

  /** Progress events must never break startup, so listener errors are contained. */
  private emitStep(event: 'startup:begin' | 'startup:step', payload: LifecycleBeginEvent | LifecycleStepEvent): void {
    try {
      this.emit(event, payload);
    } catch (err: any) {
      console.warn(`[Lifecycle] ${ event } listener failed:`, err?.message || err);
    }
  }

  isShuttingDown(): boolean {
    return this._shuttingDown;
  }

  isStarted(name: string): boolean {
    return this.started.has(name);
  }

  isAllReady(): boolean {
    return this._allReady && !this._shuttingDown;
  }

  /** Wait for one registered service without allowing callers to hang forever. */
  async waitUntilStarted(name: string, timeoutMs = 15_000): Promise<void> {
    if (this._shuttingDown) throw new Error(`Lifecycle service '${ name }' is unavailable during shutdown`);
    if (this.started.has(name)) return;
    if (!this.services.has(name)) throw new Error(`Lifecycle service '${ name }' is not registered`);
    if (this._allReady) throw new Error(`Lifecycle service '${ name }' failed to start`);

    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.off('service:ready', onServiceReady);
        this.off('all:ready', onAllReady);
        this.off('shutdown:begin', onShutdown);
        if (error) reject(error);
        else resolve();
      };
      const onServiceReady = (readyName: string) => {
        if (readyName === name) finish();
      };
      const onAllReady = () => {
        if (!this.started.has(name)) finish(new Error(`Lifecycle service '${ name }' failed to start`));
      };
      const onShutdown = () => finish(new Error(`Lifecycle service '${ name }' became unavailable during shutdown`));

      this.on('service:ready', onServiceReady);
      this.on('all:ready', onAllReady);
      this.on('shutdown:begin', onShutdown);
      timer = setTimeout(() => finish(new Error(`Lifecycle service '${ name }' did not become ready within ${ timeoutMs }ms`)), timeoutMs);

      // Close the gap between the checks above and listener registration.
      if (this.started.has(name)) finish();
      else if (this._shuttingDown) onShutdown();
      else if (this._allReady) onAllReady();
    });
  }

  /**
   * Stop a single service with a timeout.
   */
  private async stopWithTimeout(name: string, stopFn: () => Promise<void>, timeoutMs = 5000): Promise<void> {
    const t = Date.now();

    try {
      await Promise.race([
        stopFn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${ name } stop timed out after ${ timeoutMs }ms`)), timeoutMs)),
      ]);
      console.log(`[Lifecycle] '${ name }' stopped (${ Date.now() - t }ms)`);
    } catch (err: any) {
      console.warn(`[Lifecycle] '${ name }' stop failed/timed out (${ Date.now() - t }ms):`, err.message || err);
    }
  }

  /**
   * Kahn's algorithm — returns service names in dependency-first order.
   */
  private topologicalSort(): string[] {
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const [name, svc] of this.services) {
      if (!inDegree.has(name)) {
        inDegree.set(name, 0);
      }
      if (!adjacency.has(name)) {
        adjacency.set(name, []);
      }

      for (const dep of svc.dependencies) {
        if (!adjacency.has(dep)) {
          adjacency.set(dep, []);
        }
        adjacency.get(dep)!.push(name);
        inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
      }
    }

    const queue: string[] = [];

    for (const [name, degree] of inDegree) {
      if (degree === 0 && this.services.has(name)) {
        queue.push(name);
      }
    }

    const result: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;

      result.push(current);

      for (const neighbor of (adjacency.get(current) ?? [])) {
        const newDegree = (inDegree.get(neighbor) ?? 1) - 1;

        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    // Warn about cycles
    if (result.length < this.services.size) {
      const missing = [...this.services.keys()].filter(n => !result.includes(n));

      console.error(`[Lifecycle] Circular dependency detected — unreachable services: ${ missing.join(', ') }`);
    }

    return result;
  }
}

// Singleton
let instance: ServiceLifecycleManager | null = null;

export function getServiceLifecycleManager(): ServiceLifecycleManager {
  if (!instance) {
    instance = new ServiceLifecycleManager();
  }

  return instance;
}
