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

/**
 * Agents the shipped route seed used to target and no longer does. Their
 * shipped rows are archived before the current seed loads; rows a human,
 * model or correction taught are never touched.
 *   v2: vague requests moved from "sulla" to account-manager.
 *   v3: project-planner was folded into project-manager, and project
 *       execution (including code) moved from coding-manager to director.
 * If a target row is missing or disabled, routing fails closed and the chat
 * opens on the default front door.
 */
export const RETIRED_ROUTE_AGENTS = ['sulla', 'project-planner', 'coding-manager'] as const;

export async function initializeRouteSeed(): Promise<void> {
  let archived = 0;
  for (const agentId of RETIRED_ROUTE_AGENTS) archived += await ReflexModel.archiveSeedRouteExamples(agentId);
  const inserted = await ReflexModel.seedExamples(routeSeed.examples, 'seed');
  console.log(`[ReflexSeedSeeder] Route seed v${ routeSeed.version }: archived ${ archived } retired route(s), inserted ${ inserted } of ${ routeSeed.examples.length } example(s)`);
}

export async function initialize(): Promise<void> {
  const inserted = await ReflexModel.seedExamples([...seed.examples, ...routeSeed.examples], 'seed');
  console.log(`[ReflexSeedSeeder] Seed v${ seed.version }: inserted ${ inserted } of ${ seed.examples.length + routeSeed.examples.length } example(s)`);
}
