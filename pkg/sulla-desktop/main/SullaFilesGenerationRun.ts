// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Coalesces same-generation work without letting stale work block a new generation. */
export class SullaFilesGenerationRun {
  private active?:{ generation:number; promise:Promise<void> };

  run(generation:number, perform:(generation:number)=>Promise<void>):Promise<void> {
    if (this.active) {
      if (this.active.generation === generation) return this.active.promise;
      const previous = this.active.promise;
      return previous.catch(() => undefined).then(() => this.run(generation, perform));
    }
    const promise = perform(generation).finally(() => {
      if (this.active?.promise === promise) this.active = undefined;
    });
    this.active = { generation, promise };
    return promise;
  }
}
