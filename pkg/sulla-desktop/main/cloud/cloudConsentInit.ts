// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Pure consent-default planner (Goal L, decision D3). Dependency-free so the
 * migration rule can be tested with `node --test` on its own.
 *
 * - A key that already has an explicit value is never changed (existing users
 *   keep their settings, including false and mixed values).
 * - Missing keys default to off: new installs sync nothing until the user opts in.
 * - Pre-V2 installs whose only consent signal was the legacy chat sync cursor
 *   keep chat sync on, as the V2 migration did.
 */
export function planConsentInit(keys: readonly string[], current: Record<string, unknown>, legacyCursor: unknown): Record<string, boolean> {
  const missing = (k: string) => current[k] === null || current[k] === undefined;
  const cursor = parseInt(String(legacyCursor ?? '0'), 10);
  const legacyChats = Number.isFinite(cursor) && cursor > 0;
  const plan: Record<string, boolean> = {};
  for (const key of keys) {
    if (!missing(key)) continue;
    plan[key] = legacyChats && (key === 'conversations' || key === 'enabled');
  }
  return plan;
}

/** Build the opt-in patch without touching excluded sensitive preferences. */
export function recommendedConsentPatch(kinds: readonly string[]): Record<string, boolean> {
  return Object.fromEntries([['enabled', true], ...kinds.map(kind => [kind, true])]);
}
