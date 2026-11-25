# Plan: Detailed view to the approved Option A mockup

Mockup: `Projects/sulla-desktop/mockups/chat-subagent-items.html` (approved 2026-11-24, Option A).
Branch: `feat/detailed-subagent-rows` from `origin/main` @ d3556be6a31.

## What main already has (from #2889 / #2894)

- Standard hides `subagent`, `subagent_exchange` and ordinary `proactive` result cards
  (`toolGroups.ts` `project()`); only a result carrying a pending human decision stays, because it
  is the approval path, not a status card.
- One `SubAgentTraceProjection` row per `jobId:taskIndex`, joined across launch exchange, return
  exchange, result card, legacy notice and the live agent-state row; anchored to the first event's turn.
- Sources attach inside the reply (`ReplyCitationProjection` + `#sources` slot above `TurnActions`);
  `CitationRow` is the same markup in both views (no "Location" lines).

So the data model is right. The gap is the Detailed **format**: rows don't look like the mockup.

## Gaps against the mockup, and the fix

| Mockup element | Today on main | Change |
| --- | --- | --- |
| Trace column: 24px icon column with a 1px vertical line at 11.5px | border-left on the whole turn | `TraceTurn.vue`: `ol` list, `::before` line, no border |
| Turn header (`dt-th`): model (mono), tokens, sub-agent summary "2 agents: 1 returned, 1 working" | "TRACE" uppercase label + model + tokens | `TraceTurn.vue` header; summary computed in `DetailedTraceProjection.usage` from the turn's sub-agent rows |
| Row grid `24px 1fr auto 24px`, 13px/20px, verb 500, target mono 12.5 on soft bg, args mono 11.5 muted, dur 54px right, status 68px, chevron button 24px with SVG rotating 90° | `24px 1fr 88px 58px 20px`, 12px, verb 600, unicode glyph icons and ›/⌄ chevrons, whole row is the button | `TraceRow.vue` restyle; separate chevron button (`aria-expanded`, `aria-controls`) like the mockup |
| Icons: thought / shell / file / read SVG symbols | unicode glyphs | inline SVG per kind in `TraceRow.vue` |
| Thought row: icon + 13px secondary text | indented paragraph | `TraceTurn.vue` renders thoughts as a row with the thought icon |
| Note 13px/19px at 34px inset; raw block soft bg, radius 8, 12px/1.6 mono, 34px inset | 11px note, 11px payload | `TraceRow.vue` |
| Sub-agent marker = worker chart marker | first letter of agentId ("C") | Chart uses `ThreadAgentActivityPresenter` initials ("CL" for codex-luna-worker). Extract to `static ThreadAgentActivityPresenter.initials(agentId, key)` and use it in `SubAgentTraceProjection` (`details.marker`) |
| Seven status words: starting, working, no check-in, blocked, returned, failed, stopped | parked → `waiting` (an eighth word) | parked → `working`; its wait reason becomes line 2 |
| Line 3: model · effort · where · job id, then Open agent, Brief | present (model label carries effort) | keep; full job id, no truncation (no-redaction rule) |
| Read step on the trace, numbered like the reply's [n] | "Source <title>" rows | citation trace rows become `[n] Read report <title> <origin>` (or `Read source` for web URLs), matching `CitationRow`'s button wording |

## Data sources (existing only, no new IPC)

Launch/return `SubAgentExchangeMessage`, `ProactiveMessage.result.items` (`AgentResultItem`),
live `AgentStateRow` from the injected agent-state client (`AGENT_STATE_CLIENT_KEY`), check-in
history via the existing `agents:trace-history` IPC (already used on expand), `CitationMessage`.

## Standard stays still

No change to `toolGroups.ts` Standard projection, `TurnSulla.vue`, `CitationRow.vue` or
`Transcript.vue` entry markup. All edits are inside `TraceTurn.vue` / `TraceRow.vue` (rendered only
when `reportingLevel === 'debug'`) and the pure projections. Flipping the switch only adds/removes
trace turns.

## Overlap with #2893 (fix/no-tool-redaction)

#2893 edits `toolGroups.ts` (`toolText`, thinking activity) and `Transcript.vue` (`report-activity`
debug details). I don't touch either file. No redaction is added: payloads stay full.

## Tests (behaviour only)

- `SubAgentTraceProjection.spec.ts`: one row per job that updates in place across
  starting → working → parked(working) → returned; marker equals the worker-chart initials.
- `DetailedTraceProjection.spec.ts`: citation trace rows numbered to the source `num`, "Read report"
  vs "Read source"; turn summary counts.
- Existing Standard test already asserts no launch/result items; extended for parked/result mixes.
- Compile every changed `.vue` with `@vue/compiler-sfc`.
