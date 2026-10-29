// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Where each tool may run (Sulla Anywhere PLAN.md §4) and when a human tap is
 * mandatory. `placements` lists the hosts that are *eligible* to run a tool:
 * a host only offers a tool when it is eligible here AND it implements it.
 *
 * The three type aliases below mirror `packages/agent-core/src/types.ts`
 * (T1, PR #1720) character for character; a test fails if they drift. Import
 * them from agent-core once that package is on main.
 */

import { executionTargetFor, type ToolExecutionTarget } from './executionTargets';
import policy from './tool-placement-policy.json';

import type { ToolOperation } from './base';

export type ToolSideEffect = 'read' | 'write' | 'irreversible';
export type ToolPlacement = 'desktop' | 'cloud' | 'mobile';
export type ToolCredential = 'none' | { integration: string } | { vaultItem: true };

export interface ToolPlacementMetadata {
  placements: ToolPlacement[];
  relayable:  boolean;
  sideEffect: ToolSideEffect;
  credential: ToolCredential;
}

/** The fields of a `ToolManifest` that placement reads. */
export interface PlacementManifest {
  name:             string;
  category:         string;
  operationTypes?:  ToolOperation[];
  executionTarget?: ToolExecutionTarget;
  placements?:      ToolPlacement[];
  relayable?:       boolean;
  sideEffect?:      ToolSideEffect;
  credential?:      ToolCredential;
}

type FamilyName = keyof typeof policy.families;

/** Portable tool id, the same `category/name` form agent-core's ToolSpec uses. */
export function toolId(category: string, name: string): string {
  return `${ category }/${ name }`;
}

/**
 * Name segments that mean sends, posts, pays or deletes (or edits something
 * already public). A tool whose name has one of these segments is never 'read'.
 * Segments are matched whole so `get_issue_comments` and `models_list` stay reads.
 */
export const NON_READ_NAME_PATTERN = /(^|_)(un)?(send|post|publish|push|comment|review|delete|remove|del|revoke|link|update|react|pay|charge|trigger)(_|$)/;

const explicitSideEffects = new Map<string, ToolSideEffect>();
for (const sideEffect of ['read', 'write', 'irreversible'] as const) {
  for (const id of policy.sideEffects[sideEffect]) explicitSideEffects.set(id, sideEffect);
}
const desktopOnly = new Set<string>(policy.desktopOnly);
const notRelayable = new Set<string>(policy.notRelayable);
const integrationSlugs: Record<string, string> = policy.integrationSlugs;

const familyFor = (category: string): FamilyName | undefined =>
  (Object.keys(policy.families) as FamilyName[]).find(family => policy.families[family].categories.includes(category));

/** The side effect the policy file declares for a tool, if any. */
export function policySideEffect(category: string, name: string): ToolSideEffect | undefined {
  return explicitSideEffects.get(toolId(category, name));
}

/**
 * Side effect for a tool: the manifest's own field, then the policy file, then
 * 'read' only when every declared operation is a read. Anything else fails
 * closed to 'irreversible' (a test keeps every non-read tool listed explicitly).
 */
export function resolveSideEffect(manifest: PlacementManifest): ToolSideEffect {
  if (manifest.sideEffect) return manifest.sideEffect;
  const listed = policySideEffect(manifest.category, manifest.name);
  if (listed) return listed;
  const operations = manifest.operationTypes ?? [];
  return operations.length > 0 && operations.every(operation => operation === 'read') ? 'read' : 'irreversible';
}

export function resolveToolPlacement(manifest: PlacementManifest): ToolPlacementMetadata {
  const id = toolId(manifest.category, manifest.name);
  const family = familyFor(manifest.category);
  const defaults = family ? policy.families[family] : undefined;
  // Agent-local tools run in the calling agent's own workspace on the Mac, so
  // no other host can run them and a relay has no workspace to run them in.
  const target = manifest.executionTarget ?? executionTargetFor(manifest.category, manifest.name);
  const agentLocal = target === 'agent-local';
  let placements = (defaults?.placements ?? ['desktop']) as ToolPlacement[];
  let relayable = defaults?.relayable ?? false;

  if (target === 'controller' && family !== 'agents') {
    placements = policy.families.agents.placements as ToolPlacement[];
    relayable = policy.families.agents.relayable;
  } else if (target === 'workflow-manager' && family !== 'workflows') {
    placements = policy.families.workflows.placements as ToolPlacement[];
    relayable = policy.families.workflows.relayable;
  }
  if (agentLocal || desktopOnly.has(id)) placements = ['desktop'];
  if (agentLocal || notRelayable.has(id)) relayable = false;

  let credential: ToolCredential = 'none';
  if (family === 'integrations') {
    const integration = integrationSlugs[manifest.category];
    if (!integration) throw new Error(`No integration slug for tool category ${ manifest.category }`);
    credential = { integration };
  } else if (family === 'vault') {
    credential = { vaultItem: true };
  }

  return {
    placements: [...(manifest.placements ?? placements)],
    relayable:  manifest.relayable ?? relayable,
    sideEffect: resolveSideEffect(manifest),
    credential: manifest.credential ?? credential,
  };
}

/**
 * Whether a call needs a human tap before it runs. Irreversible calls (sends,
 * posts, pays, deletes) always do; writes do when relayed to another device
 * (§4.4). Any value other than 'read' or 'write' fails closed.
 */
export function requiresApproval(sideEffect: ToolSideEffect | undefined, options: { relayed?: boolean } = {}): boolean {
  if (sideEffect === 'read') return false;
  if (sideEffect === 'write') return !!options.relayed;
  return true;
}

/**
 * Side effect of one call through the generic integration proxy or an
 * integration MCP tool. Sulla can't tell a POST that creates a draft from one
 * that sends an email or charges a card, so every non-safe method is
 * irreversible until a per-action rule says otherwise.
 */
export function integrationCallSideEffect(method: string): ToolSideEffect {
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) ? 'read' : 'irreversible';
}

/** Placement for one integration-proxy call; `integration` is the account's integration slug. */
export function integrationCallPlacement(integration: string, method: string): ToolPlacementMetadata {
  return {
    placements: [...policy.families.integrations.placements] as ToolPlacement[],
    relayable:  policy.families.integrations.relayable,
    sideEffect: integrationCallSideEffect(method),
    credential: { integration },
  };
}
