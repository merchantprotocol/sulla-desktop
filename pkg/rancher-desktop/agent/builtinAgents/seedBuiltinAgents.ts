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
 * fields that are still empty; that adds a card without overwriting anything.
 * The front-door flag works the same way: it is filled only while unset.
 *
 * "Untouched" means the row's live managed content still hashes to the
 * builtin_hash the seeder last wrote, so edits from any path (UI, SQL, tools)
 * are detected without hooks. Status and enabled always stay the human's.
 *
 * Non-fatal by contract: callers wrap it; a failure re-seeds next boot.
 */

import os from 'node:os';

import {
  BUILTIN_CARD_FIELDS,
  getBuiltinAgentSpecs,
  hashManagedContent,
  readGitIdentity,
  renderBuiltinAgent,
  type BuiltinAgentSpec,
  type BuiltinManagedContent,
} from './index';
import { postgresClient } from '../database/PostgresClient';
import {
  AgentDefinitionModel,
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

function isEmptyCardValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return value == null || String(value).trim() === '';
}

/** Card fields that are empty on the row but present in the bundle. */
export function cardFillPatch(row: AgentDefinition, content: BuiltinManagedContent): AgentDefinitionPatch {
  const patch: AgentDefinitionPatch = {};
  const fill = (field: typeof BUILTIN_CARD_FIELDS[number]) => isEmptyCardValue(row[field]) && !isEmptyCardValue(content[field]);
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
  };
}

/** Pure decision for one bundled agent. Exported for tests. */
export function decideBuiltinSeedAction(
  content: BuiltinManagedContent,
  row: AgentDefinition | null,
  seenBefore: boolean,
): BuiltinSeedAction {
  if (!row) return seenBefore ? { kind: 'deleted-by-human' } : { kind: 'insert' };

  const bundleHash = hashManagedContent(content);
  const liveHash = hashManagedContent(row);
  const fill = cardFillPatch(row, content);
  const hasFill = Object.keys(fill).length > 0;

  if (row.is_builtin) {
    if (liveHash === bundleHash) {
      return row.builtin_hash === bundleHash ? { kind: 'unchanged' } : { kind: 'adopt', patch: { builtinHash: bundleHash } };
    }
    if (row.builtin_hash && liveHash === row.builtin_hash) return { kind: 'refresh' };
    return hasFill ? { kind: 'fill-cards', patch: fill } : { kind: 'kept' };
  }

  // A row this install already had (legacy import, hand-made, older build).
  // Adopt it only when it is exactly the bundled content apart from the card
  // fields that did not exist before; anything else is someone's version.
  if (hashManagedContent(applyCardPatch(row, fill)) === bundleHash) {
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
    config:        content.config,
    whenToCall:    content.when_to_call,
    whenNotToCall: content.when_not_to_call,
    send:          content.send,
    returns:       content.returns,
    costTier:      content.cost_tier,
    canCall:       content.can_call,
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
  const seen = await seenSlugs();
  const home = os.homedir();
  const git = readGitIdentity(home);

  for (const spec of specs) {
    try {
      const content = renderBuiltinAgent(spec, home, git);
      const bundleHash = hashManagedContent(content);
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
          ...(typeof spec.card?.frontDoor === 'boolean' ? { frontDoor: spec.card.frontDoor } : {}),
        });
        summary.inserted++;
        break;
      case 'refresh':
        // Compare-and-set: a human edit that lands mid-boot wins.
        if (await AgentDefinitionModel.update(row!.id, contentPatch(content, bundleHash), row!.updated_at)) summary.refreshed++;
        else summary.kept++;
        break;
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
        if (row?.front_door === null && typeof spec.card?.frontDoor === 'boolean') {
          await AgentDefinitionModel.fillFrontDoor(spec.slug, spec.card.frontDoor);
        }
        await markSeen(spec.slug);
      }
    } catch (error) {
      summary.errors.push(`${ spec.slug }: ${ error instanceof Error ? error.message : String(error) }`);
    }
  }

  return summary;
}
