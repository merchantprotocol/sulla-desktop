// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type DesktopFilesFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** What Desktop main hands over: the pinned-TLS fetch and the origin it is pinned to. */
export interface DesktopFilesTransport {
  readonly origin: string;
  readonly fetch: DesktopFilesFetch;
}

/** A transport failure is distinct from a Files API response error. */
export class SullaFilesUnreachableError extends Error {
  readonly code = 'SULLA_FILES_UNREACHABLE';

  constructor(readonly reason: string, cause?: unknown) {
    super(`Sulla Files is not reachable from Desktop (${ reason }); retry or restart Files`, { cause });
    this.name = 'SullaFilesUnreachableError';
  }
}

/** Return short, non-sensitive descriptions for network and timeout failures. */
export class FilesTransportFailureClassifier {
  static reason(error:unknown):string | undefined {
    const seen = new Set<unknown>();
    const chain:unknown[] = [];
    let current = error;
    while (current && !seen.has(current)) {
      seen.add(current);
      chain.push(current);
      current = typeof current === 'object' && current !== null ? (current as { cause?: unknown }).cause : undefined;
    }
    for (const item of chain) {
      if (item instanceof SullaFilesUnreachableError) return item.reason;
      const record = typeof item === 'object' && item !== null ? item as { name?: unknown; code?: unknown; message?: unknown } : undefined;
      const name = typeof record?.name === 'string' ? record.name : '';
      const message = typeof record?.message === 'string' ? record.message : typeof item === 'string' ? item : '';
      const code = typeof record?.code === 'string' ? record.code : '';
      if (name === 'TimeoutError' || /timed? ?out|aborted due to timeout/i.test(message)) return 'request timed out';
      const networkCode = `${ code } ${ message }`.match(/(?:net::)?ERR_[A-Z0-9_]+/i)?.[0];
      if (networkCode) return networkCode.startsWith('net::') ? networkCode : `net::${ networkCode }`;
      if (/failed to fetch|network error|socket hang up|connection (?:reset|refused|closed)/i.test(message)) return 'network error';
    }
    return undefined;
  }
}

/**
 * Holds the Desktop-only Files transport. Desktop main registers its pinned-TLS transport when it loads
 * `main/sullaFilesTls`; the Tools container never registers one, so the Desktop branch fails closed there
 * instead of importing Electron-only main code.
 */
export class DesktopFilesTransportRegistry {
  private transport: DesktopFilesTransport | undefined;
  private readonly resetListeners = new Set<() => void>();

  register(transport: DesktopFilesTransport): void {
    this.transport = transport;
  }

  resolve(): DesktopFilesTransport {
    if (!this.transport) throw new Error('Desktop Files transport is not available in this runtime');
    return this.transport;
  }

  onReset(listener:() => void):() => void {
    this.resetListeners.add(listener);
    return () => this.resetListeners.delete(listener);
  }

  notifyReset():void {
    for (const listener of [...this.resetListeners]) listener();
  }
}

export const desktopFilesTransport = new DesktopFilesTransportRegistry();
