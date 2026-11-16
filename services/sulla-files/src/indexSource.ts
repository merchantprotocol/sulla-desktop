// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { IndexSourceRepository } from './Repositories/IndexSourceRepository.js';
import { DesktopIndexSource, StoredIndexSource, type MaterializedIndexSource } from './Services/IndexSourceMaterializer.js';
import { Store } from './store.js';

import type { Config } from './config.js';
import type pg from 'pg';

export { DesktopIndexSource, StoredIndexSource } from './Services/IndexSourceMaterializer.js';

/** Delegating shim: an IndexingQueue source over a live Files root. */
export function desktopIndexSource(filesRoot:string, db?:pg.Pool):(file:any) => Promise<MaterializedIndexSource> {
  const source = new DesktopIndexSource(filesRoot, db, db ? new IndexSourceRepository(db) : undefined);
  return file => source.materialize(file);
}

/** Delegating shim for index.ts. chunkStore: the process-wide chunk store, so evicted chunks hydrate instead of failing with ENOENT. */
export function storedIndexSource(db:pg.Pool, config:Config, chunkStore?:Store):(file:any) => Promise<MaterializedIndexSource> {
  const source = new StoredIndexSource(db, config, chunkStore ?? new Store(config.chunkRoot), new IndexSourceRepository(db));
  return file => source.materialize(file);
}
