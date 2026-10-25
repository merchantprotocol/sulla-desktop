/**
 * Process-wide record of whether Desktop booted on the native Sulla runtime
 * instead of Lima. Main-process code that behaves differently on the runtime
 * (agent run location, snapshots, factory reset) reads it from here.
 */

export interface SullaRuntimeGuestUser {
  name: string;
  uid:  number;
}

let active = false;
let guestUser: SullaRuntimeGuestUser | undefined;

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
