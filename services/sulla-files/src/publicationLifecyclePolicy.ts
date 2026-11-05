// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { isUseCasePath } from './useCasePaths.js';

type Collection = { system_area?: string | null };

/** Chooses the initial lifecycle state without relying on a database trigger. */
export class PublicationLifecyclePolicy {
  constructor(private readonly useCasePath: (collection:Collection, path:string) => boolean = isUseCasePath) {}

  statusForWrite(input:{ collection:Collection; path:string; createdByType:string }):'draft'|null {
    const agentAuthored = input.createdByType === 'agent' || input.createdByType === 'agent-run';
    return agentAuthored && this.useCasePath(input.collection, input.path) ? 'draft' : null;
  }
}
