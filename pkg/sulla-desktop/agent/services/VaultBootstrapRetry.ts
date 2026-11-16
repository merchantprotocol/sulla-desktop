// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface VaultBootstrapAttemptResult {
  ok:boolean;
  error?:string;
}

export interface VaultBootstrapRetryDependencies {
  sleep(milliseconds:number):Promise<void>;
  log(message:string):void;
}

/** Retries only a refused vault connection during the first-boot startup race. */
export class VaultBootstrapRetry {
  private static readonly MAX_ATTEMPTS = 60;
  private static readonly DELAY_MS = 1_000;
  private readonly dependencies:VaultBootstrapRetryDependencies;

  constructor(dependencies:VaultBootstrapRetryDependencies = {
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    log: message => console.warn(message),
  }) { this.dependencies = dependencies }

  async run<T extends VaultBootstrapAttemptResult>(attempt:() => Promise<T>):Promise<T> {
    for (let number = 1; ; number++) {
      const result = await attempt();

      if (result.ok || !result.error?.includes('ECONNREFUSED') || number >= VaultBootstrapRetry.MAX_ATTEMPTS) return result;
      if (number === 1 || number % 5 === 0) {
        this.dependencies.log(`[VaultKeyService] Vault connection refused during startup; retry ${ number + 1 } in 1s`);
      }
      await this.dependencies.sleep(VaultBootstrapRetry.DELAY_MS);
    }
  }
}
