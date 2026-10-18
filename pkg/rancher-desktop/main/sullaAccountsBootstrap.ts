import fs from 'node:fs';
import path from 'node:path';

import paths from '@pkg/utils/paths';

export interface AccountsOwnerSession {
  expiresAt: string;
  token:     string;
}

export class SullaAccountsBootstrap {
  readonly secretPath = path.join(paths.appHome, 'accounts', 'bootstrap.secret');

  async readSecret():Promise<string> {
    let handle:fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(this.secretPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    } catch {
      throw new Error('ACCOUNTS_BOOTSTRAP_NOT_PROVISIONED');
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('ACCOUNTS_BOOTSTRAP_NOT_PROVISIONED');
      const value = (await handle.readFile('utf8')).trim();
      if (!/^[A-Za-z0-9_-]{64}$/.test(value)) throw new Error('ACCOUNTS_BOOTSTRAP_NOT_PROVISIONED');
      return value;
    } finally {
      await handle.close();
    }
  }
}
