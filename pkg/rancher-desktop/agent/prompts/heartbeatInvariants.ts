/**
 * Runtime invariants for the Heartbeat autonomous ("continuous operator") prompt.
 *
 * Build-time tests (heartbeatPrompt.test.ts and PR #588) guard the prompt SOURCE
 * on main. They cannot catch a *stale deployed binary* running reverted prompt
 * code — the exact failure mode PR #581 introduced, and the reason the grbz/o8SF
 * lane keeps gating a human "rebuild Desktop + eyeball the live prompt" step.
 *
 * This module lets the running process verify its OWN composed system prompt on
 * every heartbeat wake (see SystemPromptBuilder.build). If the deployed prompt is
 * stale or reverted, the check fails at runtime and the process self-reports it —
 * turning the manual live-acceptance gate into an automatic signal.
 */

/** Phrases the deployed continuous-operator heartbeat prompt MUST contain. */
export const HEARTBEAT_REQUIRED_PHRASES = [
  'not a one-task worker',
  'does not cap you at one item per wake',
  'Never end a wake idle',
] as const;

/**
 * #581-signature phrases that must NEVER reappear — the pick-one / do-one / STOP
 * cycle-ceiling framing Jonathon explicitly rejected. Matched case-insensitively.
 */
export const HEARTBEAT_FORBIDDEN_PHRASES = [
  'Cycle Budget',
  'Pick ONE',
  'pick exactly one',
  'make one move',
  'one move per',
  'one item per cycle',
] as const;

export interface HeartbeatInvariantResult {
  /** True when every required phrase is present and no forbidden phrase appears. */
  ok:        boolean;
  /** Required phrases that were NOT found (stale/reverted prompt). */
  missing:   string[];
  /** Forbidden phrases that WERE found (STOP-ceiling framing reintroduced). */
  forbidden: string[];
}

/**
 * Check a composed system-prompt string against the continuous-operator
 * invariants. Pure and side-effect free.
 *
 * Required phrases are matched exactly (the wording is load-bearing); forbidden
 * phrases are matched case-insensitively so casing tricks can't slip a STOP
 * ceiling past the guard.
 */
export function checkHeartbeatPromptInvariants(promptText: string): HeartbeatInvariantResult {
  const haystack = promptText || '';
  const lower = haystack.toLowerCase();

  const missing = HEARTBEAT_REQUIRED_PHRASES.filter(phrase => !haystack.includes(phrase));
  const forbidden = HEARTBEAT_FORBIDDEN_PHRASES.filter(phrase => lower.includes(phrase.toLowerCase()));

  return {
    ok: missing.length === 0 && forbidden.length === 0,
    missing,
    forbidden,
  };
}
