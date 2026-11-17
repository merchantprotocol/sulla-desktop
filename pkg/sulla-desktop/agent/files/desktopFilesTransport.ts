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

/**
 * Holds the Desktop-only Files transport. Desktop main registers its pinned-TLS transport when it loads
 * `main/sullaFilesTls`; the Tools container never registers one, so the Desktop branch fails closed there
 * instead of importing Electron-only main code.
 */
export class DesktopFilesTransportRegistry {
  private transport: DesktopFilesTransport | undefined;

  register(transport: DesktopFilesTransport): void {
    this.transport = transport;
  }

  resolve(): DesktopFilesTransport {
    if (!this.transport) throw new Error('Desktop Files transport is not available in this runtime');
    return this.transport;
  }
}

export const desktopFilesTransport = new DesktopFilesTransportRegistry();
