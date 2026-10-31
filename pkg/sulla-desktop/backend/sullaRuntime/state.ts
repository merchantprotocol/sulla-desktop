// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Process-wide record of whether Desktop booted on the native Sulla runtime
 * Main-process code that behaves differently on the runtime
 * (agent run location, snapshots, factory reset) reads it from here.
 */

export interface SullaRuntimeGuestUser {
  name: string;
  uid:  number;
}

let active = false;
let guestUser: SullaRuntimeGuestUser | undefined;
let suspendOnNextStop = false;
let plannedOptionalServices: Set<string> | undefined;
let startFailure: { reason: string; message: string } | undefined;

export function setSullaRuntimeActive(value: boolean, user?: SullaRuntimeGuestUser): void {
  active = value;
  guestUser = value ? user : undefined;
}

export function isSullaRuntimeActive(): boolean {
  return active;
}

/** The guest account the runtime created from sulla.user/sulla.uid, when it did. */
export function sullaRuntimeGuestUser(): SullaRuntimeGuestUser | undefined {
  return guestUser;
}

/**
 * App quit: the next runtime stop saves the VM state so the next launch
 * resumes it. Stops for settings changes and restarts shut the guest down.
 */
export function suspendSullaRuntimeOnNextStop(): void {
  suspendOnNextStop = true;
}

/** Whether the stop in progress should suspend; clears the request. */
export function takeSullaRuntimeSuspendRequest(): boolean {
  const requested = suspendOnNextStop;

  suspendOnNextStop = false;

  return requested;
}

/** The optional compose services this boot is bringing up (set once compose is prepared). */
export function setSullaOptionalServicesPlanned(services: string[] | undefined): void {
  plannedOptionalServices = services ? new Set(services) : undefined;
}

/** Whether boot is bringing this optional service up; undefined until it knows. */
export function isSullaOptionalServicePlanned(service: string): boolean | undefined {
  return plannedOptionalServices?.has(service);
}

/**
 * Why the last backend start failed, in plain words, until the next start.
 * Lets a window that opens after the 'sulla-backend-start-failed' event still show it.
 */
export function setSullaRuntimeStartFailure(failure: { reason: string; message: string } | undefined): void {
  startFailure = failure;
}

export function sullaRuntimeStartFailure(): { reason: string; message: string } | undefined {
  return startFailure;
}

export class SullaRuntimeUnsupportedError extends Error {
  constructor(feature: string) {
    super(`${ feature } is not supported on the Sulla runtime yet`);
    this.name = 'SullaRuntimeUnsupportedError';
  }
}

/** Throws a clear error for features the runtime does not implement yet. */
export function assertSupportedOnSullaRuntime(feature: string): void {
  if (active) {
    throw new SullaRuntimeUnsupportedError(feature);
  }
}

/**
 * The runtime guest has no agent CLIs or Python, so nothing can run "in the
 * VM". Agents configured for the VM run in a container instead; the stored
 * definition is left alone.
 */
export function effectiveAgentRunLocation<T extends string>(location: T): T | 'container' {
  return active && location === 'vm' ? 'container' : location;
}
