// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Delegating shims for callers outside the E5 S5 slice. The policy is Services/ProtectedFilePolicy.ts
// and its SQL is Repositories/ProtectedFileRepository.ts; each call builds them from the passed-in db.
import { ProtectedFileRepository } from './Repositories/ProtectedFileRepository.js';
import { ProtectedFilePolicy } from './Services/ProtectedFilePolicy.js';

import type pg from 'pg';

export { ProtectedFilePolicy } from './Services/ProtectedFilePolicy.js';

export function isProtectedPath(path:string):boolean { return ProtectedFilePolicy.isProtectedPath(path) }
export function protectedPathError():Error { return ProtectedFilePolicy.error() }
export function isAuditLogPath(path:string):boolean { return ProtectedFilePolicy.isAuditLogPath(path) }
export function assertUnprotectedFile(db:Pick<pg.Pool, 'query'>, file:{ id:string; path:string }):Promise<void> {
  return new ProtectedFilePolicy(new ProtectedFileRepository(db)).assertUnprotected(file);
}
