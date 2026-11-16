// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { FilesIdentity } from '../auth.js';

/** HTTP-status errors and actor checks shared by the document lifecycle services. */
export class LifecycleHttpError {
  static of(status:number, message:string):Error & { status:number } {
    return Object.assign(new Error(message), { status });
  }

  static isAgent(actor:FilesIdentity):boolean { return Boolean(actor.agentId || actor.jobId || actor.threadId) }

  /** Throws 403 unless the actor is a human (not an agent run, job or thread). */
  static requireHuman(actor:FilesIdentity):FilesIdentity {
    if (LifecycleHttpError.isAgent(actor)) throw LifecycleHttpError.of(403, 'human identity required');
    return actor;
  }
}
