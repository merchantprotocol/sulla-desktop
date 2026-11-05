// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { isUseCasePath } from './useCasePaths.js';

export type PublicationCollection = { system_area?: string | null };

export interface ReplicatedPublicationLifecycle {
  publication_status?: string | null;
  published_at?: unknown;
  published_by?: string | null;
}

/** Chooses the initial lifecycle state without relying on a database trigger. */
export class PublicationLifecyclePolicy {
  constructor(private readonly useCasePath: (collection:PublicationCollection, path:string) => boolean = isUseCasePath) {}

  statusForWrite(input:{ collection:PublicationCollection; path:string; createdByType:string }):'draft'|null {
    const agentAuthored = input.createdByType === 'agent' || input.createdByType === 'agent-run';
    return agentAuthored && this.useCasePath(input.collection, input.path) ? 'draft' : null;
  }

  sanitizeReplication(input:{ collection:PublicationCollection; path:string; createdByType:string; lifecycle:ReplicatedPublicationLifecycle }):ReplicatedPublicationLifecycle {
    const malformedPublication = input.lifecycle.publication_status === 'published'
      && this.statusForWrite({ collection:input.collection, path:input.path, createdByType:input.createdByType }) === 'draft'
      && !(input.lifecycle.published_at && input.lifecycle.published_by);
    return malformedPublication
      ? { ...input.lifecycle, publication_status:'draft', published_at:null, published_by:null }
      : { ...input.lifecycle };
  }
}
