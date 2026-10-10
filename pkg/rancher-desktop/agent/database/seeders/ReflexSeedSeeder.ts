/**
 * ReflexSeedSeeder
 *
 * Loads the shipped Reflex training seed (agent/reflex/seed/reflex-seed.json,
 * built by scripts/build-reflex-seed.mjs) so Reflex helps a brand-new user
 * from their first message: questions about a feature open that feature, and
 * explicit safe commands run instantly.
 *
 * Registered under a versioned name (reflex-seed-v<N>), so each seed version
 * runs once per install. Safe to re-run: seedExamples skips any example that
 * already exists, including ones the user has forgotten.
 */

import seed from '../../reflex/seed/reflex-seed.json';
import routeSeed from '../../reflex/seed/route-seed.json';
import { ReflexModel } from '../models/ReflexModel';

export const REFLEX_SEED_VERSION = seed.version;

export async function initialize(): Promise<void> {
  const inserted = await ReflexModel.seedExamples([...seed.examples, ...routeSeed.examples], 'seed');
  console.log(`[ReflexSeedSeeder] Seed v${ seed.version }: inserted ${ inserted } of ${ seed.examples.length + routeSeed.examples.length } example(s)`);
}
