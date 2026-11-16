// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type * as Automerge from '@automerge/automerge';
import type pg from 'pg';

import { loadTextDocument, saveTextDocument, textDocumentHeads, type TextDocument } from '../automergeText.js';
import type { AutomergeDocumentRepository } from '../Repositories/AutomergeDocumentRepository.js';

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

/** Loads and saves a file's Automerge text document (moved from app.ts saveAutomergeVersion/currentAutomergeDocument). */
export class AutomergeTextStore {
  constructor(private readonly documents:AutomergeDocumentRepository) {}

  async save(client:pg.PoolClient, fileId:string, versionId:string, document:Automerge.Doc<TextDocument>):Promise<void> {
    const bytes = saveTextDocument(document), heads = textDocumentHeads(document);
    await this.documents.saveVersion(client, fileId, versionId, bytes, JSON.stringify(heads));
    // Saving touches only this version row. Scanning every snapshot here made
    // write latency and native Automerge allocations grow with file history.
    // Historical payloads are trimmed by the bounded background retention job;
    // their heads remain available for stale-base merges.
  }

  async current(queryable:Queryable, fileId:string, versionId:string):Promise<Automerge.Doc<TextDocument> | undefined> {
    const stored = await this.documents.currentDocument(queryable, fileId);
    if (stored) return loadTextDocument(stored.document);
    // One-time compatibility bridge for rows written before migration 063.
    const legacy = await this.documents.legacyVersionDocument(queryable, versionId, fileId);
    return legacy ? loadTextDocument(legacy.document) : undefined;
  }
}
