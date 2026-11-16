// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { TransactionRunner } from '../FilesTransaction.js';
import { RecordingMetadataRepository } from '../Repositories/RecordingMetadataRepository.js';
import { UNINDEXED_SYSTEM_AREAS } from '../systemAreaIngest.js';

import type pg from 'pg';

export interface Segment { start: number; end: number; text: string }

export interface RecordingEnrichmentOutput {
  fileId: string;
  versionId: string;
  language: string | null;
  transcript: Segment[];
  chapters: Array<{ start:number; end:number; title:string }>;
  duration: number | null;
}

export type RecordingEnrichmentOutcome = 'stored' | 'abandoned-ineligible' | 'abandoned-stale';

/** Final, lock-protected persistence boundary for transcript-derived plaintext. */
export class RecordingEnrichmentWriter {
  constructor(
    private readonly transactions:TransactionRunner,
    private readonly metadata:RecordingMetadataRepository,
  ) {}

  static forPool(db:pg.Pool):RecordingEnrichmentWriter {
    return new RecordingEnrichmentWriter(new TransactionRunner(db), new RecordingMetadataRepository(db));
  }

  persist(output:RecordingEnrichmentOutput):Promise<RecordingEnrichmentOutcome> {
    return this.transactions.run('recording-enrichment-persist', async client => {
      const metadata = this.metadata.on(client);
      const file = await metadata.lockEligibility(output.fileId);
      if (!file || file.deleted_at || file.protected || UNINDEXED_SYSTEM_AREAS.has(file.system_area as string)) {
        await metadata.purgeFile(output.fileId);
        return 'abandoned-ineligible';
      }
      if (file.current_version_id !== output.versionId) {
        await metadata.deleteVersionJob(output.versionId);
        return 'abandoned-stale';
      }
      await metadata.store(output, output.transcript.map(segment => segment.text).join(' '));
      return 'stored';
    });
  }
}
