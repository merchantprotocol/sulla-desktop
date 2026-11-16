// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { IpcController, IpcRegistrar } from './ipc/IpcController';

export interface UsageEventsDependencies {
  summary(hours: number | undefined, profileId: string): Promise<unknown>;
  /** The signed-in contractor id; throws on local/offline installs. */
  activeContractorId(): Promise<string>;
}

/** usage:summary — provider usage for the active (or given) profile. */
export class UsageIpcController implements IpcController {
  constructor(private readonly ipc: IpcRegistrar, private readonly deps: UsageEventsDependencies) {}

  register(): void {
    this.ipc.handle('usage:summary', async(_event: unknown, options?: { hours?: number; profileId?: string }) => {
      let profileId = options?.profileId?.trim();
      if (!profileId) {
        try {
          profileId = (await this.deps.activeContractorId()).trim();
        } catch { /* local/offline installs use the default profile */ }
      }

      return this.deps.summary(options?.hours, profileId || 'default');
    });
  }
}
