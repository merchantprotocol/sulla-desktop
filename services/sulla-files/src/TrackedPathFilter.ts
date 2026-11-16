// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { resolve, sep } from 'node:path';

import type { FileRootConfig } from './config.js';

/** Path rules for native tracked roots: ignore patterns, sensitive folders and root containment. */
export class TrackedPathFilter {
  static readonly defaultIgnores = ['.DS_Store', '._*', '*.tmp', '~$*', '.git/', 'node_modules/', '*.sulla-conflict-*', '.sulla-trash/', '.sulla-operation-recovery/', 'master.key'];

  static matchIgnore(path:string, patterns:string[]):boolean {
    const parts = path.split('/');
    return patterns.some(raw => {
      const pattern = raw.trim().replace(/^\//, '');
      if (!pattern || pattern.startsWith('#')) return false;
      if (pattern.endsWith('/')) return parts.slice(0, -1).includes(pattern.slice(0, -1));
      const expression = new RegExp(`^${ pattern.split('*').map(value => value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')).join('.*') }$`);
      return expression.test(path) || parts.some(part => expression.test(part));
    });
  }

  /** Wallet and vault folders are never tracked, whatever the user configured. */
  static isSensitive(relativePath:string):boolean {
    return relativePath.replaceAll('\\', '/').split('/').some(part => {
      const value = part.toLowerCase();
      return value.includes('wallet') || value === 'vault' || value === 'vaults';
    });
  }

  /** Absolute path of `relativePath` inside `root`; throws when it would escape the root. */
  static inside(root:FileRootConfig, relativePath:string):string {
    const absolute = resolve(root.path, relativePath);
    if (absolute !== root.path && !absolute.startsWith(`${ root.path }${ sep }`)) throw new Error('path escapes Files folder');
    return absolute;
  }
}
