// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { PotionEmbedder } from '../memory/potionEmbedder';
import { PostgresUseCaseCatalogSource, type SuggestionSqlClient } from './repositories/PostgresUseCaseCatalogSource';
import { UseCaseChangeBus, type UseCaseChangeTransport } from './UseCaseChangeBus';
import { UseCaseSuggestionIndex, type SuggestionEmbedder } from './UseCaseSuggestionIndex';

export const potionSuggestionEmbedderLoader = async(): Promise<PotionEmbedder> => {
  const { resolveBundledModelDir } = await import('../utils/sullaPaths');
  const dir = resolveBundledModelDir('potion-retrieval-32M');
  if (!dir) throw new Error('Potion retrieval model directory unavailable');
  return PotionEmbedder.load(dir);
};

/**
 * Main-process composition root: owns the one bus + index pair. The bus
 * hears writers in this process directly and every other writer (models,
 * agent tools, other processes) over the injected transport.
 */
export class UseCaseSuggestionCompositionRoot {
  readonly notifier: UseCaseChangeBus;
  readonly index: UseCaseSuggestionIndex;
  constructor(db: SuggestionSqlClient, builtinSkillSlugs: readonly string[], transport: UseCaseChangeTransport, embedderLoader: () => Promise<SuggestionEmbedder> = potionSuggestionEmbedderLoader) {
    this.notifier = new UseCaseChangeBus(transport);
    this.index = new UseCaseSuggestionIndex(embedderLoader, new PostgresUseCaseCatalogSource(db, builtinSkillSlugs), this.notifier);
  }
  /**
   * Warm immediately (suggestions must not wait on Redis), and refresh once the
   * subscription is live: any write whose event fired before then is caught by
   * that fingerprint check instead of waiting for the 15 s backstop.
   */
  start(): void {
    void this.index.warm();
    void this.notifier.start().then(() => this.index.refresh());
  }
  stop(): void { this.index.dispose(); void this.notifier.stop(); }
}
