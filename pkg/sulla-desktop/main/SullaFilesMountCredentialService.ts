// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { VMExecutor } from '@pkg/backend/backend';
import type { SullaFilesMountCredentials } from './sullaFilesMountManager';

export class SullaFilesMountCredentialService {
  private pendingWrite?:Promise<void>;

  constructor(
    private readonly executor:() => VMExecutor | undefined,
    private readonly credentials:() => (() => Promise<SullaFilesMountCredentials>) | undefined,
    private readonly generation:() => number,
    private readonly tokenPath:string,
  ) {}

  async refresh(generation:number):Promise<void> {
    const previous = this.pendingWrite?.catch(() => undefined) ?? Promise.resolve();
    const write = previous.then(async() => {
      const executor = this.executor();
      const provider = this.credentials();
      if (!executor || !provider || generation !== this.generation()) throw new Error('Files mount credential custody is unavailable');
      const credentials = await provider();
      if (generation !== this.generation()) throw new Error('Files mount credential generation changed');
      if (credentials.token.length < 64 || credentials.token.length > 4096) throw new Error('Files mount credentials are invalid');
      await this.writeGuestSecret(this.tokenPath, `${ credentials.token }\n`);
      if (generation !== this.generation()) throw new Error('Files mount credential generation changed');
    });

    this.pendingWrite = write;
    try { await write } finally { if (this.pendingWrite === write) this.pendingWrite = undefined; }
  }

  /** Wait for any in-flight token write to finish (lock drains it before stopping the guest). */
  async settle():Promise<void> {
    await this.pendingWrite?.catch(() => undefined);
  }

  private async writeGuestSecret(destination:string, contents:string):Promise<void> {
    // Re-read the guest: it may have been torn down while credentials were fetched.
    const executor = this.executor();
    if (!executor) throw new Error('Files mount guest is unavailable');
    const child = executor.spawn(
      // POSIX sh and coreutils/busybox only: the guest may have no python3. The rename is the atomic step; `sync` flushes it.
      { root: true }, 'sh', '-c', `umask 077; cat > ${ destination }.new && mv -f ${ destination }.new ${ destination } && sync`,
    );
    const complete = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Guest secret write failed (${ code ?? 'signal' })`)));
    });
    child.stdin?.end(contents);
    await complete;
  }
}
