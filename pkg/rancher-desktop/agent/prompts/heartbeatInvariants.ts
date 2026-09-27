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

/** Phrases the deployed Heartbeat prompt MUST contain. */
export const HEARTBEAT_REQUIRED_PHRASES = [
  // Inventor posture (2026-09-27): the wake is Heartbeat's time to brainstorm
  // and run real experiments. Idle "nothing changed" wakes are failures.
  'Heartbeat — Your Time to Think, Invent, and Try',
  'A wake that ends with "nothing changed" is a failed wake',
  'The Wake Loop — Think, Choose, Try, Learn',
  'Write down at least five fresh ideas',
  'Thinking about an idea is not trying it',
  'End the wake only after at least one experiment is recorded',
  // Durable idea memory across fresh sessions.
  'The Idea Lab — Your Memory Between Wakes',
  "slug 'heartbeat-idea-lab'",
  'Read the lab before brainstorming, every wake',
  'Never move a lab task into the ordered effective execution-entry lane',
  // Anti-stagnation rules.
  'No Idle Wakes',
  'A focus directive from your Human sets priority, not a cage',
  "protect their attention, not your activity",
  'idle wakes in disguise',
  'stagnation alert',
  // Goals from the install's north star.
  'The Heartbeat Goal section carries the north star for this install',
  'The north star never widens your authority',
  'A wake ending is a pause, not a stop',
  // Authority boundary. A deployed prompt missing any of these has lost its
  // gate, not merely been reworded.
  'Two-Door Rule',
  '**Irreversible / high-blast:** stage fully, then ask once',
  'Never push to main',
  'Design every experiment to fit the reversible door',
  // Single-owner conveyor.
  'Projects project-state is your only durable agenda',
  'RETIRED',
  'Every state or concern has exactly one owner',
  'protected planning routine',
  'protected execution routine',
  'protected review routine',
  'durable wait monitor',
  'deterministic recovery',
  'create a second dispatch, planning, review, custody, wait, or recovery path',
  'Never conceal a broken conveyor by manually doing the stranded task',
  "Resolve every task's effective lane and semantic role",
  // Comment hygiene without the silence trap.
  'Never post "still blocked," "still waiting," or "unchanged."',
  'One material event gets one concise comment',
  'Never brief that nothing changed',
  'Notify once when a decision is created or materially changes',
  // Stability covenant: the prompt is frozen — heartbeat may not tweak itself.
  'This Prompt Is Frozen',
  'never let install-local Markdown replace or append to it',
  "Never flip 'heartbeatEnabled'",
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
  // Legacy duplicate-owner doctrine removed by #675. These headings and
  // directives made Heartbeat a second planner, verifier, and task worker.
  'Blocked Recovery Council — Decide, Do Not Escalate',
  'Auto-Dispatch on Blocked — Independent Council, Then Act',
  'Task-Type Playbooks',
  'Artifact-per-Cycle Contract',
  "Review tasks returned to 'in_review'",
  'three independent high-reasoning planner agents',
  'launch ordinary todo workers',
  'run its own planner council',
  'inspect and close every in_review task',
  'commit, push, or open PRs as ordinary artifact custodian',
  'update marketing trackers as ordinary artifact custodian',
  'poll unchanged CI or external gates',
  'reclaim healthy leases based only on time',
  'perform core-routine state transitions directly',
  'one task per wake',
  // The pre-2026-09-27 control-plane doctrine taught Heartbeat that an
  // unchanged board meant writing nothing and ending the wake, which produced
  // hours of "nothing changed this wake" loops. It must not come back.
  'Projects Comment Hygiene — Delta or Silence',
  'If the state and evidence are unchanged, write nothing',
  'Heartbeat must never:',
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
