/**
 * ServiceLifecycleManager — dependency-aware startup/shutdown orchestrator.
 *
 * Services register with a name, dependency list, start() and stop() functions.
 * startAll() topologically sorts by dependency and starts in order.
 * stopAll() tears down in reverse order with per-service timeouts.
 */

import { EventEmitter } from 'events';
import Logging from '@pkg/utils/logging';

const console = Logging.sulla;

interface ServiceDefinition {
  name: string;
  dependencies: string[];
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** If true, this service is NOT stopped during a 'restart' (e.g. Docker containers). */
  persistOnRestart?: boolean;
}

type StopMode = 'full' | 'restart';

class ServiceLifecycleManager extends EventEmitter {
  private services = new Map<string, ServiceDefinition>();
  private started = new Set<string>();
  private _shuttingDown = false;
  private _startOrder: string[] = [];

  /**
   * Register a service with the lifecycle manager.
   */
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
    opts?: { persistOnRestart?: boolean; alreadyStarted?: boolean },
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
    });
    if (opts?.alreadyStarted) {
      this.started.add(name);
    }
  }

  /**
   * Start all registered services in dependency order.
   */
  async startAll(): Promise<void> {
    this._shuttingDown = false;
    const order = this.topologicalSort();

    this._startOrder = order;
    console.log(`[Lifecycle] Starting services: ${ order.join(' → ') }`);

    for (const name of order) {
      if (this._shuttingDown) {
        console.log(`[Lifecycle] Shutdown requested, aborting startup at '${ name }'`);
        break;
      }

      const svc = this.services.get(name)!;

      // Skip services that were pre-started (registered with alreadyStarted: true)
      if (this.started.has(name)) {
        continue;
      }

      // Check that all dependencies actually started
      const unmet = svc.dependencies.filter(d => !this.started.has(d));

      if (unmet.length > 0) {
        console.warn(`[Lifecycle] Skipping '${ name }' — unmet dependencies: ${ unmet.join(', ') }`);
        continue;
      }

      const t = Date.now();

      try {
        console.log(`[Lifecycle] Starting '${ name }'...`);
        await svc.start();
        this.started.add(name);
        console.log(`[Lifecycle] '${ name }' ready (${ Date.now() - t }ms)`);
        this.emit('service:ready', name);
      } catch (err: any) {
        console.error(`[Lifecycle] '${ name }' failed to start (${ Date.now() - t }ms):`, err.message || err);
        // Don't throw — allow independent services to continue
      }
    }

    this.emit('all:ready');
    console.log(`[Lifecycle] Startup complete — ${ this.started.size }/${ order.length } services running`);
  }

  /**
   * Stop all started services in reverse dependency order.
   */
  async stopAll(mode: StopMode = 'full'): Promise<void> {
    if (this._shuttingDown) {
      console.log('[Lifecycle] stopAll() already in progress, skipping');

      return;
    }
    this._shuttingDown = true;
    this.emit('shutdown:begin', mode);

    // Reverse the startup order for teardown
    const order = [...this._startOrder].reverse();

    console.log(`[Lifecycle] Stopping services (${ mode }): ${ order.join(' → ') }`);

    for (const name of order) {
      if (!this.started.has(name)) {
        continue;
      }

      const svc = this.services.get(name);

      if (!svc) {
        continue;
      }

      // In restart mode, skip services that should persist
      if (mode === 'restart' && svc.persistOnRestart) {
        console.log(`[Lifecycle] Keeping '${ name }' alive (restart mode)`);
        continue;
      }

      await this.stopWithTimeout(name, svc.stop);
      this.started.delete(name);
      this.emit('service:stopped', name);
    }

    console.log(`[Lifecycle] Shutdown complete (${ mode })`);
  }

  isShuttingDown(): boolean {
    return this._shuttingDown;
  }

  isStarted(name: string): boolean {
    return this.started.has(name);
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
        // Dependency points to this service
        if (!adjacency.has(dep)) {
          adjacency.set(dep, []);
        }
        adjacency.get(dep)!.push(name);
        inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
      }
    }

    // Seed queue with zero-dependency services
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
