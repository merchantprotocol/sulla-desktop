// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ProtectedFileRepository } from '../Repositories/ProtectedFileRepository.js';

/**
 * Which files no caller may read, share, index or change: key material, wallets and vaults by
 * path, files marked protected, and audit logs anywhere except the Logs system area.
 */
export class ProtectedFilePolicy {
  constructor(private readonly repository:ProtectedFileRepository) {}

  static isProtectedPath(path:string):boolean {
    return path.replaceAll('\\', '/').split('/').some(part => {
      const value = part.toLowerCase();
      return value === 'master.key' || value.includes('wallet') || value === 'vault' || value === 'vaults';
    });
  }

  static isAuditLogPath(path:string):boolean { return /^audit\/(files|vault)\/[A-Za-z0-9_-]+\.jsonl$/.test(path) }

  static error():Error { return Object.assign(new Error('Protected system file'), { status: 403 }) }

  async assertUnprotected(file:{ id:string; path:string }):Promise<void> {
    const systemLog = ProtectedFilePolicy.isAuditLogPath(file.path) && await this.repository.isInLogsArea(file.id);
    if ((ProtectedFilePolicy.isProtectedPath(file.path) && !systemLog) || await this.repository.isMarkedProtected(file.id)) throw ProtectedFilePolicy.error();
  }
}
