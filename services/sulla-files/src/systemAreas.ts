// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Delegating shims for callers outside the E5 S5 slice (index.ts, app.ts, localManager.ts). The
// provisioning is Services/SystemAreaProvisioner.ts and its SQL Repositories/SystemAreaRepository.ts.
import { TransactionRunner } from './FilesTransaction.js';
import { SystemAreaRepository } from './Repositories/SystemAreaRepository.js';
import { SystemAreaProvisioner } from './Services/SystemAreaProvisioner.js';

import type { Config } from './config.js';
import type pg from 'pg';

export { SystemAreaProvisioner } from './Services/SystemAreaProvisioner.js';

export function collectionIdFor(userId:string, rootId = 'default'):string {
  return SystemAreaProvisioner.collectionIdFor(userId, rootId);
}

export function ensureSystemAreas(db:pg.Pool, config:Config):Promise<void> {
  return new SystemAreaProvisioner(new TransactionRunner(db), new SystemAreaRepository()).ensure(config);
}

/** Read-only system storage is structural: no caller grants can override it. */
export function assertSystemAreaWritable(area:unknown):void { SystemAreaProvisioner.assertWritable(area) }
