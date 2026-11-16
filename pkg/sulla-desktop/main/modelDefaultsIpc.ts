// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { MODEL_DEFAULTS_IPC } from '../agent/languagemodels/modelDefaultsTypes';

import type { IpcController, IpcMainRegistrar } from './ipc/IpcController';

export interface ModelDefaultsPort {
  state(): unknown;
  set(patch: Record<string, unknown>): Promise<unknown>;
  reset(): Promise<unknown>;
}

/** Preferences → AI models → Defaults. What each default resolves to is computed in the renderer from the routing state. */
export class ModelDefaultsIpcController implements IpcController {
  constructor(private readonly ipc: IpcMainRegistrar, private readonly defaults: ModelDefaultsPort) {}

  register(): void {
    for (const channel of Object.values(MODEL_DEFAULTS_IPC)) this.ipc.removeHandler(channel);
    this.ipc.handle(MODEL_DEFAULTS_IPC.get, () => this.defaults.state());
    this.ipc.handle(MODEL_DEFAULTS_IPC.set, async(_event, patch) => {
      await this.defaults.set(patch && typeof patch === 'object' ? patch : {});

      return this.defaults.state();
    });
    this.ipc.handle(MODEL_DEFAULTS_IPC.reset, async() => {
      await this.defaults.reset();

      return this.defaults.state();
    });
  }
}
