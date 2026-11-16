// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { FilesIdentity } from '../auth.js';

/** Builds the HTTP-shaped errors and identity keys shared by receipt operations. */
export class OperationFailure {
  static readonly uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  static of(status:number, message:string):Error { return Object.assign(new Error(message), { status }) }

  static coded(status:number, message:string, code:string):Error { return Object.assign(new Error(message), { status, code }) }

  static busy():Error {
    return OperationFailure.of(409, 'Files changed concurrently or are busy; refresh before retrying. Receipt requests must reuse their idempotency key');
  }

  /** The idempotency scope of one caller: the same user on another device or agent run is a different scope. */
  static scope(actor:FilesIdentity):string {
    return JSON.stringify([actor.kind, actor.deviceId, actor.agentId ?? '', actor.jobId ?? '', actor.threadId ?? '']);
  }
}
