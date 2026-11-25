// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * seedBuiltinAgents — boot-time installer for the agents that ship with Sulla.
 *
 * Runs every boot, idempotent, never deletes, never clobbers a human edit:
 *   - missing slug, never seen on this install  → insert (is_builtin = true)
 *   - missing slug, seen before (human deleted)  → leave it deleted
 *   - built-in row untouched since the last seed → refresh to the bundle
 *   - built-in row the human edited               → keep their content
 *   - pre-existing non-built-in row identical to the bundle → adopt as built-in
 *   - any other existing row                      → keep its content
 * The only write to an edited or non-built-in row is filling directory-card
 * fields that are still empty. can_call [] is the default unrestricted team,
 * not a missing card, so it is never filled. A hashed built-in whose managed
 * content no longer matches builtin_hash is left alone, including cleared
 * routing strings. A row with no hash yet, and a non-built-in row, can still
 * receive blank string cards.
 * The front-door flag is filled only while unset. An explicit null is stored
 * outside the hash as config.frontDoorChosen, so a null-only edit survives
 * even when the managed hash still matches and prompt upgrades still run.
 * Refresh copies that marker onto the new bundle config. A customized hashed
 * built-in is not filled either. A non-built-in row is filled only when it
 * has no marker.
 *
 * "Untouched" means the row's live managed content still hashes to the
 * builtin_hash the seeder last wrote, so edits from any path (UI, SQL, tools)
 * are detected without hooks. Both sides hash only what AgentDefinitionModel
 * stores: the model category policy rewrites provider/model/model_slot/
 * model_priority and config.modelChoice, so those are left out and the agent's
 * model choice survives a refresh. Rows that still carry an older 'sha256:'
 * hash of the raw bundle are never refreshed or front-door filled: one that
 * already equals the current bundle only has its hash re-stamped, and any other
 * stays exactly as it is, so existing instructions are not upgraded behind the
 * user's back. Status and enabled always stay the human's.
 *
 * Agents the bundle stops shipping are listed in its "retired" array;
 * retireBuiltinAgents switches off its own untouched copy once, never deletes.
 *
 * Non-fatal by contract: callers wrap it; a failure re-seeds next boot.
 */

import os from 'node:os';

import {
  BUILTIN_CARD_FIELDS,
  FRONT_DOOR_CHOSEN_KEY,
  getBuiltinAgentSpecs,
  getRetiredBuiltinSlugs,
  BuiltinAgentHasher,
  readGitIdentity,
  RETIRED_CODING_MANAGER_SLUGS,
  RETIRED_OBSERVATION_AGENT_SLUGS,
  renderBuiltinAgent,
  isRetiredCodingManagerSlug,
  type BuiltinAgentSpec,
  type BuiltinManagedContent,
} from './index';
import { postgresClient } from '../database/PostgresClient';
import {
  AgentDefinitionModel,
  DEFAULT_AGENT_RUN_LOCATION,
  type AgentDefinition,
  type AgentDefinitionPatch,
} from '../database/models/AgentDefinitionModel';

export type BuiltinSeedAction =
  | { kind: 'insert' }
  | { kind: 'deleted-by-human' }
  | { kind: 'unchanged' }
  | { kind: 'refresh' }
  | { kind: 'adopt'; patch: AgentDefinitionPatch }
  | { kind: 'fill-cards'; patch: AgentDefinitionPatch }
  | { kind: 'kept' };

function isEmptyCardValue(field: typeof BUILTIN_CARD_FIELDS[number], value: unknown): boolean {
  // [] is a saved default team. Only a missing (non-array) can_call is unfilled.
  if (field === 'can_call') return !Array.isArray(value);
  if (Array.isArray(value)) return value.length === 0;
  return value == null || String(value).trim() === '';
}

/** True when an editor save explicitly chose front door "not set". */
export function hasExplicitFrontDoorChoice(config: unknown): boolean {
  return !!config && typeof config === 'object' && Object.prototype.hasOwnProperty.call(config, FRONT_DOOR_CHOSEN_KEY);
}

/**
 * Fill the bundle front door only while the column is unset, the bundle names
 * a boolean, and nobody has saved an explicit null or customized this built-in.
 * A matching managed hash is not enough: front door is outside that hash.
 */
export function shouldFillBuiltinFrontDoor(row: AgentDefinition | null, bundleFrontDoor: unknown): boolean {
  if (!row || row.front_door !== null || typeof bundleFrontDoor !== 'boolean') return false;
  if (hasExplicitFrontDoorChoice(row.config)) return false;
  // Only a row still matching its own hash; an older 'sha256:' row never does, so it is left alone.
  if (row.is_builtin && row.builtin_hash && BuiltinAgentHasher.hashManagedContent(row) !== row.builtin_hash) return false;
  return true;
}

/** Card fields that are empty on the row but present in the bundle. */
export function cardFillPatch(row: AgentDefinition, content: BuiltinManagedContent): AgentDefinitionPatch {
  const patch: AgentDefinitionPatch = {};
  const fill = (field: typeof BUILTIN_CARD_FIELDS[number]) => isEmptyCardValue(field, row[field]) && !isEmptyCardValue(field, content[field]);
  if (fill('when_to_call')) patch.whenToCall = content.when_to_call;
  if (fill('when_not_to_call')) patch.whenNotToCall = content.when_not_to_call;
  if (fill('send')) patch.send = content.send;
  if (fill('returns')) patch.returns = content.returns;
  if (fill('cost_tier')) patch.costTier = content.cost_tier;
  if (fill('can_call')) patch.canCall = content.can_call;
  return patch;
}

function applyCardPatch(row: AgentDefinition, patch: AgentDefinitionPatch): AgentDefinition {
  return {
    ...row,
    ...(patch.whenToCall !== undefined ? { when_to_call: patch.whenToCall } : {}),
    ...(patch.whenNotToCall !== undefined ? { when_not_to_call: patch.whenNotToCall } : {}),
    ...(patch.send !== undefined ? { send: patch.send } : {}),
    ...(patch.returns !== undefined ? { returns: patch.returns } : {}),
    ...(patch.costTier !== undefined ? { cost_tier: patch.costTier } : {}),
    ...(patch.canCall !== undefined ? { can_call: patch.canCall } : {}),
    ...(patch.agentAwareness !== undefined ? { agent_awareness: patch.agentAwareness } : {}),
  };
}

/** Pure decision for one bundled agent. Exported for tests. */
export function decideBuiltinSeedAction(
  content: BuiltinManagedContent,
  row: AgentDefinition | null,
  seenBefore: boolean,
): BuiltinSeedAction {
  if (!row) return seenBefore ? { kind: 'deleted-by-human' } : { kind: 'insert' };
  // Files is authoritative once a version has been published; the boot fallback must not overwrite it.
  if (row.use_case_file_id && row.use_case_version_id) return { kind: 'kept' };

  const bundleHash = BuiltinAgentHasher.hashManagedContent(content);
  const liveHash = BuiltinAgentHasher.hashManagedContent(row);
  const legacyBundleHash = BuiltinAgentHasher.hashManagedContentBeforeAgentAwareness(content);
  const legacyLiveHash = BuiltinAgentHasher.hashManagedContentBeforeAgentAwareness(row);
  const fill = cardFillPatch(row, content);
  const hasFill = Object.keys(fill).length > 0;

  if (row.is_builtin) {
    if (liveHash === bundleHash) {
      return row.builtin_hash === bundleHash ? { kind: 'unchanged' } : { kind: 'adopt', patch: { builtinHash: bundleHash } };
    }
    if (row.builtin_hash && (liveHash === row.builtin_hash || legacyLiveHash === row.builtin_hash)) return { kind: 'refresh' };
    // Hash no longer matches a seeded built-in: the person saved it, or it carries
    // an older 'sha256:' hash and differs from the bundle. Leave it wholly as is;
    // do not put bundle card text back over a cleared field. Not-yet-hashed rows still fill.
    if (row.builtin_hash) return { kind: 'kept' };
    return hasFill ? { kind: 'fill-cards', patch: fill } : { kind: 'kept' };
  }

  // A row this install already had (legacy import, hand-made, older build).
  // Adopt it only when it is exactly the bundled content apart from the card
  // fields that did not exist before; anything else is someone's version.
  if (BuiltinAgentHasher.hashManagedContent(applyCardPatch(row, fill)) === bundleHash || BuiltinAgentHasher.hashManagedContentBeforeAgentAwareness(applyCardPatch(row, fill)) === legacyBundleHash) {
    return { kind: 'adopt', patch: { ...fill, isBuiltin: true, builtinHash: bundleHash } };
  }
  return hasFill ? { kind: 'fill-cards', patch: fill } : { kind: 'kept' };
}

function contentPatch(content: BuiltinManagedContent, bundleHash: string): AgentDefinitionPatch {
  return {
    name:          content.name,
    description:   content.description,
    systemPrompt:  content.system_prompt,
    promptContent: content.prompt_content,
    soulContent:   content.soul_content,
    goalsContent:  content.goals_content,
    promptFiles:   content.prompt_files,
    allowedTools:  content.allowed_tools,
    skillRefs:     content.skill_refs,
    routineRefs:   content.routine_refs,
    modelPriority: content.model_priority,
    provider:      content.provider,
    model:         content.model,
    modelSlot:     content.model_slot,
    config:        content.config,
    whenToCall:    content.when_to_call,
    whenNotToCall: content.when_not_to_call,
    send:          content.send,
    returns:       content.returns,
    costTier:      content.cost_tier,
    canCall:       content.can_call,
    agentAwareness: content.agent_awareness,
    isBuiltin:     true,
    builtinHash:   bundleHash,
  };
}

async function seenSlugs(): Promise<Set<string>> {
  const rows = await postgresClient.query('SELECT slug FROM agent_builtin_seed_ledger', []);
  return new Set(rows.map((row: { slug: string }) => row.slug));
}

async function markSeen(slug: string): Promise<void> {
  await postgresClient.query('INSERT INTO agent_builtin_seed_ledger (slug) VALUES ($1) ON CONFLICT (slug) DO NOTHING', [slug]);
}

export interface BuiltinSeedSummary {
  inserted:  number;
  refreshed: number;
  adopted:   number;
  filled:    number;
  kept:      number;
  unchanged: number;
  skipped:   number;
  errors:    string[];
}

export async function seedBuiltinAgents(specs: BuiltinAgentSpec[] = getBuiltinAgentSpecs()): Promise<BuiltinSeedSummary> {
  const summary: BuiltinSeedSummary = { inserted: 0, refreshed: 0, adopted: 0, filled: 0, kept: 0, unchanged: 0, skipped: 0, errors: [] };
  // Retire these before the rest of the seed work so a transient builtin-ledger error cannot
  // prevent long-tail rows from being switched off at startup.
  const retiredManagers = await retireLongTailCodingManagers([...RETIRED_CODING_MANAGER_SLUGS, ...RETIRED_OBSERVATION_AGENT_SLUGS]);
  summary.errors.push(...retiredManagers.errors);
  const seen = await seenSlugs();
  const home = os.homedir();
  const git = readGitIdentity(home);

  for (const spec of specs) {
    try {
      if (isRetiredCodingManagerSlug(spec.slug)) continue;
      const content = renderBuiltinAgent(spec, home, git);
      const bundleHash = BuiltinAgentHasher.hashManagedContent(content);
      const row = await AgentDefinitionModel.findBySlug(spec.slug);
      const action = decideBuiltinSeedAction(content, row, seen.has(spec.slug));

      switch (action.kind) {
      case 'insert':
        await AgentDefinitionModel.create({
          slug:          spec.slug,
          ...contentPatch(content, bundleHash),
          name:          content.name,
          status:        'production',
          enabled:       true,
          sourceKind:    'local',
          // Only newly installed built-ins inherit the rollout default. Existing
          // rows are never rewritten, so an explicit VM selection stays intact.
          runLocation:   DEFAULT_AGENT_RUN_LOCATION,
          ...(typeof spec.card?.frontDoor === 'boolean' ? { frontDoor: spec.card.frontDoor } : {}),
        });
        summary.inserted++;
        break;
      case 'refresh': {
        // Compare-and-set: a human edit that lands mid-boot wins.
        // contentPatch replaces config, so an explicit null front door has to be copied back.
        const patch = contentPatch(content, bundleHash);
        if (hasExplicitFrontDoorChoice(row?.config)) patch.config = { ...(patch.config ?? {}), [FRONT_DOOR_CHOSEN_KEY]: null };
        if (await AgentDefinitionModel.update(row!.id, patch, row!.updated_at)) summary.refreshed++;
        else summary.kept++;
        break;
      }
      case 'adopt':
        if (await AgentDefinitionModel.update(row!.id, action.patch, row!.updated_at)) summary.adopted++;
        else summary.kept++;
        break;
      case 'fill-cards':
        if (await AgentDefinitionModel.update(row!.id, action.patch, row!.updated_at)) summary.filled++;
        else summary.kept++;
        break;
      case 'kept': summary.kept++; break;
      case 'unchanged': summary.unchanged++; break;
      case 'deleted-by-human': summary.skipped++; break;
      }

      if (action.kind !== 'deleted-by-human') {
        const bundleFrontDoor = spec.card?.frontDoor;
        if (typeof bundleFrontDoor === 'boolean' && shouldFillBuiltinFrontDoor(row, bundleFrontDoor)) {
          await AgentDefinitionModel.fillFrontDoor(spec.slug, bundleFrontDoor);
        }
        await markSeen(spec.slug);
      }
    } catch (error) {
      summary.errors.push(`${ spec.slug }: ${ error instanceof Error ? error.message : String(error) }`);
    }
  }

  return summary;
}

/** Ledger key recording that a retirement was handled, so it runs once per install. */
export function retiredLedgerKey(slug: string): string {
  return `retired:${ slug }`;
}

/**
 * Pure decision for a retired built-in. Switch it off only when the seeder
 * still owns it: installed as built-in, enabled, and untouched since the last
 * seed. An edited row is the human's; a row they re-enable later stays on,
 * because the retirement is handled once.
 */
export function shouldRetireBuiltin(row: AgentDefinition | null, handledBefore: boolean): boolean {
  if (!row || handledBefore || !row.is_builtin || !row.enabled || !row.builtin_hash) return false;
  return BuiltinAgentHasher.hashManagedContent(row) === row.builtin_hash;
}

export interface BuiltinRetireSummary {
  disabled: number;
  errors:   string[];
}

export interface RetiredCodingManagerSummary {
  archived: number;
  errors:   string[];
}

/**
 * Permanently retire the legacy Coding Manager variants across all row origins. Existing rows
 * and history stay in place; repeated startup checks both enforce archive/disabled state and
 * retry worker-binding cleanup if a previous call failed.
 */
export async function retireLongTailCodingManagers(
  slugs: readonly string[] = RETIRED_CODING_MANAGER_SLUGS,
): Promise<RetiredCodingManagerSummary> {
  const summary: RetiredCodingManagerSummary = { archived: 0, errors: [] };
  for (const slug of slugs) {
    let row: AgentDefinition | null;
    try {
      row = await AgentDefinitionModel.findBySlug(slug);
      if (!row) continue;
      if (row.enabled || row.status !== 'archive') {
        const archived = await AgentDefinitionModel.update(row.id, { enabled: false, status: 'archive' });
        if (!archived) throw new Error(`Could not archive retired agent ${ slug }.`);
        summary.archived++;
      }
    } catch (error) {
      summary.errors.push(`${ slug }: ${ error instanceof Error ? error.message : String(error) }`);
      continue;
    }

    try {
      const { workerModelRouting } = await import('@pkg/agent/services/WorkerModelRouting');
      await workerModelRouting.removeBindingForDefinition(slug, row.id);
    } catch (error) {
      summary.errors.push(`${ slug } worker binding: ${ error instanceof Error ? error.message : String(error) }`);
    }
  }
  return summary;
}

/**
 * Switch off built-ins the bundle no longer ships (bundle "retired" list).
 * Never deletes: the row and its history stay, disabled.
 */
export async function retireBuiltinAgents(slugs: string[] = getRetiredBuiltinSlugs()): Promise<BuiltinRetireSummary> {
  const summary: BuiltinRetireSummary = { disabled: 0, errors: [] };
  if (!slugs.length) return summary;
  const seen = await seenSlugs();
  for (const slug of slugs) {
    try {
      const key = retiredLedgerKey(slug);
      if (seen.has(key)) continue;
      const row = await AgentDefinitionModel.findBySlug(slug);
      if (shouldRetireBuiltin(row, false) && await AgentDefinitionModel.update(row!.id, { enabled: false }, row!.updated_at)) {
        summary.disabled++;
      }
      await markSeen(key);
    } catch (error) {
      summary.errors.push(`${ slug }: ${ error instanceof Error ? error.message : String(error) }`);
    }
  }
  return summary;
}
