// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Compose services that run only while something uses them.
 *
 * Boot leaves these stopped. A caller asks for one before it talks to it
 * (`acquireOnDemandService` holds it for the length of a call); the first
 * request of a backend generation brings the container up to the current
 * compose definition, later ones just start it. A reaper stops a service that
 * has had no lease for its idle period and no outside demand (for the threat
 * proxy: running agent containers).
 *
 * Callers live in the Electron main process; every guest command goes through
 * the runner the backend registers once the guest's Docker is up.
 */

import { THREAT_PROXY_CONTAINER } from '@pkg/backend/threatProxyEgress';
import Logging from '@pkg/utils/logging';

const console = Logging.sullaRuntime;

export const SULLA_COMPOSE_COMMAND = ['docker', 'compose', '-f', '/tmp/sulla-docker-compose.yml', '-p', 'sulla'] as const;

/** Runs argv in the guest as root and resolves with stdout. */
export type OnDemandGuestRunner = (args: string[]) => Promise<string>;

export type OnDemandServiceName = 'python_runtime' | 'shell_runtime' | 'node_runtime' | 'threat_proxy';

const IDLE_MS = 10 * 60_000;
const START_TIMEOUT_MS = 90_000;
const REAPER_INTERVAL_MS = 60_000;

export const ON_DEMAND_SERVICES: Readonly<Record<OnDemandServiceName, string>> = {
  python_runtime: 'sulla_python_runtime',
  shell_runtime:  'sulla_shell_runtime',
  node_runtime:   'sulla_node_runtime',
  threat_proxy:   THREAT_PROXY_CONTAINER,
};

/** Function runtime name (function.yaml `spec.runtime`) to its compose service. */
export const FUNCTION_RUNTIME_SERVICES: Readonly<Record<string, OnDemandServiceName>> = {
  python: 'python_runtime',
  shell:  'shell_runtime',
  node:   'node_runtime',
};

interface ServiceState {
  leases:     number;
  lastUsed:   number;
  /** The container was brought up to this generation's compose definition. */
  reconciled: boolean;
  /** Start and stop of one service never overlap. */
  queue:      Promise<unknown>;
}

let runner: OnDemandGuestRunner | undefined;
/** Published images to pull before the first start of a generation (bundled ones are pinned). */
let refreshImages: Partial<Record<OnDemandServiceName, string>> = {};
let reaper: ReturnType<typeof setInterval> | undefined;
const states = new Map<OnDemandServiceName, ServiceState>();
const demand = new Map<OnDemandServiceName, () => Promise<boolean>>();

function state(service: OnDemandServiceName): ServiceState {
  let current = states.get(service);

  if (!current) {
    current = { leases: 0, lastUsed: 0, reconciled: false, queue: Promise.resolve() };
    states.set(service, current);
  }

  return current;
}

function serialize<T>(service: OnDemandServiceName, task: () => Promise<T>): Promise<T> {
  const current = state(service);
  const next = current.queue.then(task, task);

  current.queue = next.catch(() => undefined);

  return next;
}

function guest(): OnDemandGuestRunner {
  if (!runner) throw new Error('Sulla services are not running yet');

  return runner;
}

async function containerStatus(container: string): Promise<string> {
  try {
    return (await guest()(['docker', 'inspect', '--format',
      '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', container])).trim();
  } catch {
    return 'missing';
  }
}

const ready = (status: string) => status === 'running healthy' || status === 'running none';

async function waitReady(container: string): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let status = await containerStatus(container);

  while (!ready(status)) {
    if (Date.now() >= deadline) throw new Error(`${ container } did not become healthy (last status: ${ status })`);
    await new Promise(resolve => setTimeout(resolve, 500));
    status = await containerStatus(container);
  }
}

async function start(service: OnDemandServiceName): Promise<void> {
  const container = ON_DEMAND_SERVICES[service];
  const current = state(service);

  if (ready(await containerStatus(container))) return;
  const composeUp = () => guest()([...SULLA_COMPOSE_COMMAND, 'up', '-d', '--no-deps', service]);
  const dockerStart = () => guest()(['docker', 'start', container]);

  // Compose applies this app version's definition (image, limits) once per
  // generation; after that a plain start is enough. Each falls back to the other.
  if (current.reconciled) {
    await dockerStart().catch(composeUp);
  } else {
    const refresh = refreshImages[service];

    if (refresh) {
      await guest()(['docker', 'pull', refresh]).catch(error => {
        console.warn(`[on-demand] could not refresh ${ refresh }; using the image in the VM:`, (error as Error).message?.split('\n')[0]);
      });
    }
    await composeUp().catch(async(error) => {
      console.warn(`[on-demand] compose could not start ${ service }; starting the existing container:`, (error as Error).message?.split('\n')[0]);
      await dockerStart();
    });
    current.reconciled = true;
  }
  await waitReady(container);
  console.log(`[on-demand] ${ service } started`);
}

/** Start the service if needed and wait until it is healthy. */
export function ensureOnDemandService(service: OnDemandServiceName): Promise<void> {
  state(service).lastUsed = Date.now();
  startReaper();

  return serialize(service, () => start(service)).finally(() => {
    state(service).lastUsed = Date.now();
  });
}

/**
 * Start the service and hold it until the returned release is called, so a
 * long call is never stopped by the idle reaper. Release is idempotent.
 */
export async function acquireOnDemandService(service: OnDemandServiceName): Promise<() => void> {
  const current = state(service);

  current.leases += 1;
  try {
    await ensureOnDemandService(service);
  } catch (error) {
    current.leases -= 1;
    throw error;
  }
  let released = false;

  return () => {
    if (released) return;
    released = true;
    current.leases -= 1;
    current.lastUsed = Date.now();
  };
}

/** Function runtimes by `spec.runtime`; unknown runtimes hold nothing. */
export async function acquireFunctionRuntime(runtime: string): Promise<() => void> {
  const service = FUNCTION_RUNTIME_SERVICES[runtime];

  return service ? acquireOnDemandService(service) : () => undefined;
}

/**
 * Outside demand for a service, checked by the reaper: while it resolves
 * true the service is kept (and started) even without leases.
 */
export function setOnDemandServiceDemand(service: OnDemandServiceName, check: () => Promise<boolean>): void {
  demand.set(service, check);
  startReaper();
}

async function reap(): Promise<void> {
  if (!runner) return;
  for (const service of Object.keys(ON_DEMAND_SERVICES) as OnDemandServiceName[]) {
    const current = state(service);
    const wanted = await demand.get(service)?.().catch(() => false) ?? false;

    if (wanted) {
      await ensureOnDemandService(service).catch(error => console.warn(`[on-demand] could not start ${ service }:`, (error as Error).message));
      continue;
    }
    if (current.leases > 0 || Date.now() - current.lastUsed < IDLE_MS) continue;
    await serialize(service, async() => {
      // Re-check inside the queue: a caller may have arrived meanwhile.
      if (current.leases > 0 || Date.now() - current.lastUsed < IDLE_MS) return;
      const container = ON_DEMAND_SERVICES[service];

      if (!(await containerStatus(container)).startsWith('running')) return;
      console.log(`[on-demand] ${ service } idle; stopping it`);
      await guest()(['docker', 'stop', '-t', '10', container]);
    }).catch(error => console.warn(`[on-demand] could not stop ${ service }:`, (error as Error).message));
  }
}

function startReaper(): void {
  if (reaper) return;
  let running = false;

  reaper = setInterval(() => {
    if (running) return;
    running = true;
    reap().finally(() => { running = false });
  }, REAPER_INTERVAL_MS);
  reaper.unref?.();
}

/**
 * Called by the backend for every managed-services generation once compose is
 * written. Containers left running by a previous session count as idle, so the
 * reaper stops them unless something uses them.
 */
export function configureOnDemandServices(
  run: OnDemandGuestRunner,
  images: Partial<Record<OnDemandServiceName, string>> = {},
): void {
  runner = run;
  refreshImages = { ...images };
  for (const current of states.values()) {
    current.reconciled = false;
    if (current.leases === 0) current.lastUsed = 0;
  }
  startReaper();
}

export function clearOnDemandServices(run?: OnDemandGuestRunner): void {
  if (run && runner !== run) return;
  runner = undefined;
}
