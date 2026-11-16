// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { BootstrapUnlockResponse } from '../../../services/sulla-vault/src/contracts';

export interface VaultBootstrapProcessRuntime {
  whenReady(): Promise<void>;
  exit(code: number): void;
  argv: readonly string[];
  writeStdout(value: string): void;
  waitForExit(): Promise<never>;
  configurePinnedTls(): void;
  bootstrap(): Promise<BootstrapUnlockResponse>;
  updateMasterCache(): Promise<void>;
}

/** Owns the one-shot bootstrap process lifecycle; runtime services are swappable in tests. */
export class VaultBootstrapProcess {
  constructor(private readonly runtime: VaultBootstrapProcessRuntime) {}

  async run(): Promise<never> {
    try {
      await this.runtime.whenReady();
      this.runtime.configurePinnedTls();
      if (this.runtime.argv.includes('--sulla-vault-cache-update-helper')) {
        await this.runtime.updateMasterCache();
        this.runtime.writeStdout(`${ JSON.stringify({ ok: true, updated: true }) }\n`);
      } else {
        const result = await this.runtime.bootstrap();
        this.runtime.writeStdout(`${ JSON.stringify({ ok: true, state: result.state }) }\n`);
      }
      this.runtime.exit(0);
    } catch (error) {
      this.runtime.writeStdout(`${ JSON.stringify({ ok: false, error: (error as Error).message }) }\n`);
      this.runtime.exit(1);
    }
    return await this.runtime.waitForExit();
  }
}
