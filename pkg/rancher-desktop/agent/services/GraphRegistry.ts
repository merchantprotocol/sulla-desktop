import * as fs from 'fs';
import * as path from 'path';

import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { getCurrentModel } from '../languagemodels';
import { Graph, createHeartbeatGraph, createAgentGraph, createSubconsciousGraph, BaseThreadState, AgentGraphState, GeneralGraphState } from '../nodes/Graph';
import { saveThreadState, loadThreadState } from '../nodes/ThreadStateStore';
import { toolRegistry } from '../tools/registry';
import { resolveSullaAgentsDir, resolveAllAgentsDirs, findAgentDir } from '../utils/sullaPaths';

// Side-effect: ensure tool manifests are registered before any graph runs
import '../tools/manifests';
// Back-compat re-export
export type { AgentGraphState as OverlordThreadState } from '../nodes/Graph';

const registry = new Map<string, {
  graph: Graph<any>;
  state: BaseThreadState;
}>();

// ============================================================================
// SUBCONSCIOUS MIDDLEWARE — TOOL ASSIGNMENTS
// ============================================================================

/** Summarizer: no tools — pure text analysis and XML output */
const SUMMARIZER_TOOLS: string[] = [];

/** Tool-Result Digester: no tools — pure text analysis and XML output */
const TOOL_RESULT_DIGESTER_TOOLS: string[] = [];

/** Observation Writer: write/archive observations and update identity files */
const OBSERVATION_AGENT_TOOLS: string[] = [
  'add_observational_memory',     // Insert or update an observation row
  'remove_observational_memory',  // Soft-archive a stale observation
  'search_observations',          // Check for existing similar observations before adding
  'list_observations',            // Browse active observations
  // NOTE: intentionally NO file/shell/code tools. This is an OBSERVER, not an
  // actor — it must never write files, run commands, or edit the codebase. The
  // old file_search/read_file/write_file grant let it take real filesystem
  // action from a subconscious pass; identity is now DB-backed (the domain
  // identity observers write identity_observations), so no file access is
  // needed. Keeping this list to observation-DB tools makes acting structurally
  // impossible (strict allowedToolNames path — no dynamic tool injection).
];

/** Observation Recall: read-only — search and list observations for context injection */
const OBSERVATION_RECALL_TOOLS: string[] = [
  'search_observations',  // ILIKE search on observation content
  'list_observations',    // Priority-sorted list of active observations
];

/** Identity Observer (writer): domain-scoped identity_observations CRUD */
const IDENTITY_OBSERVER_TOOLS: string[] = [
  'add_identity_observation',      // Insert or update a domain-keyed identity row
  'remove_identity_observation',   // Soft-archive a superseded row
  'search_identity_observations',  // Dedup check before adding
  'list_identity_observations',    // Browse the domain's current picture
];

/** Identity Observation Recall: read-only — search/list domain rows for context injection */
const IDENTITY_OBSERVATION_RECALL_TOOLS: string[] = [
  'search_identity_observations',
  'list_identity_observations',
];

/**
 * Per-domain focus config for the identity observer template. Mirrors
 * ~/sulla/identity/ (human / business / world / agent). Adding a new domain
 * observer = one entry here + one dispatch line in SubconsciousMiddleware —
 * no new table, model, tools, or migration.
 */
interface IdentityObserverDomainConfig {
  /** The identity_observations.domain value rows are written under. */
  domain:       string;
  /** Who/what this observer studies — substituted into the prompt template. */
  subjectLabel: string;
  /** Domain-specific guidance: what to look for, with category examples. */
  focus:        string;
  /**
   * Extra WRITER-only discipline appended to the observer prompt. The
   * self/agent domain uses it to pin the stricter subject/kind/third-person
   * contract its rows follow; human/business/world leave it undefined and
   * inherit the shared template unchanged.
   */
  writerNote?:  string;
}

const IDENTITY_OBSERVER_DOMAINS: Record<string, IdentityObserverDomainConfig> = {
  human: {
    domain:       'human',
    subjectLabel: 'the human user',
    focus: `Observe the HUMAN USER — who they are, not what task is running:
- identity: name, role, background, circumstances they reveal
- relationship: people in their life and how they relate to them
- association: companies, projects, communities, groups they belong to
- personality: temperament, values, humor, how they handle friction (conclusions — L1)
- habit: recurring behaviors, schedules, working patterns
- preference: likes/dislikes, how they want things done, communication style
- goal: what they are trying to achieve, short- and long-term`,
  },
  agent: {
    domain:       'agent',
    subjectLabel: 'the Sulla agent',
    focus: `Observe the SULLA AGENT ITSELF as a working partner — what is durably
true of how it works and how it works WITH this human. NOT a recap of the last
reply, NOT a mood, NOT persona fanfic. If it would not still matter in a new
chat next week, it is not a self-observation.

Two subjects (write each row under exactly one):
- agent — this AI (Sulla) as a working partner: its standing constraints,
  methods, commitments, capabilities, limits, and preferences.
- agent.user — how THIS agent and THIS human work together: the overlap layer,
  the reciprocal working style. This layer is usually MORE valuable than
  abstract facts about the AI — prefer it.

Record only things that pass all three gates below. Good material:
- a correction the human gave ("stop asking so many questions", "don't push without a PR")
- a constraint it discovered ("cannot X in the VM", "this tool is the source of truth")
- a working agreement now in force ("agent drafts PRs; the human merges")
- a method that repeatedly worked or repeatedly failed
- a standing preference for how it should act (terse, propose-then-wait, never email)
- a capability or hard limit ("can write identity proposals, cannot activate soul")

Reject (never write these):
- "I was helpful", restating SOUL or the identity files, mood/persona fanfic,
  "I noticed I care about…"
- this-turn task status ("edited foo.ts"), one-off guesses about its own character
- traits like helpful / curious / proactive UNLESS the human stated them as a rule
- feelings or inner life`,
    writerNote: `## How to write a self-observation (agent domain)

Every candidate row must pass ALL THREE gates before you write it:
1. Is this still true if this chat is deleted?
2. Did the human correct it, or did it happen more than once?
3. Would a future chat do something differently if it knew this?
If ANY answer is no, do not write it. Most turns reveal nothing durable — when
they don't, finish immediately without writing.

Field contract for every agent-domain row:
- content — the fact as ONE sentence, THIRD PERSON, standing or past tense.
  Write "Agent must not push live; it opens PRs for review." — NOT "I should be
  more careful" and NOT "I will not push to main." First person or self-talk
  pollutes the snapshot: always start with "Agent ..." or "The pair ..." /
  "The human ...", never "I ...".
- source — the subject: exactly \`agent\` or \`agent.user\`.
- category — the kind: exactly one of correction | constraint | method |
  commitment | preference.
- basis — the evidence: a short quote or a turn reference.
- level — certainty: L3 for a human correction or an explicit rule/limit the
  human stated; L2 for a constraint or method established from evidence or seen
  more than once; L1 ONLY for a genuine standing conclusion, never a one-off
  guess about its own character.

Prefer agent.user rows — how the pair works is worth more than facts about the
AI in the abstract.`,
  },
  business: {
    domain:       'business',
    subjectLabel: 'the human\'s business or employment',
    focus: `Observe the HUMAN'S BUSINESS OR EMPLOYMENT — what they do for a living
and the organization(s) behind it, not the current task:
- identity: what the business is — its name, industry, what it sells or does
- model: how it makes money — customers, pricing, revenue streams, unit economics
- operations: how the work gets done — routes, tools, suppliers, staff, cadence
- market: customers, competitors, partners, territory
- priorities: what the business is trying to grow, fix, or protect right now
- constraints: costs, risks, obligations, deadlines, regulatory/legal limits
- assets: products, routes, properties, equipment, IP the business owns

One human can run several ventures — keep each distinct. Record what is durable
about the business, not one-off task status.`,
    writerNote: `## Certainty for business facts

The SUBJECT is the BUSINESS, not the person — personal identity belongs to the
human domain.
- L3 — the human stated it about their business directly ("we bill clients per
  seat", "we only get paid for what sells through, not what we deliver").
- L2 — established from what they discussed, not stated as a headline fact. Set
  basis to the evidence.
- L1 — a conclusion you reasoned about the business ("the business is
  cash-tight", "margins are shrink-sensitive"), always with basis.
If a venture is distinct from another, keep its rows distinct.`,
  },
  world: {
    domain:       'world',
    subjectLabel: 'the outside world as it bears on this human',
    focus: `Observe THE OUTSIDE WORLD — external events, conditions, and changes —
but ONLY where they plausibly bear on THIS human, THIS agent, or the human's
business. You are NOT a news feed. The default is to record NOTHING. A world fact
earns a row only when someone here would act differently, plan differently, or be
exposed because of it.

RELEVANCE GATE — before writing anything:
- Call search_identity_observations on the \`business\` domain, then the \`human\`
  domain, to load what this human does and cares about.
- A world fact qualifies ONLY if it connects to something you found there. If the
  business is stock trading, market-moving events qualify; if it is a delivery
  route, fuel prices, local events, weather, and retail trends qualify; software/AI
  work → model releases, competitor tools, platform changes qualify.
- No connection to the human / business / agent → do NOT record it, however
  newsworthy.

Categories: event (something happened), condition (an ongoing state), trend (a
direction of change), actor (an external org/person that matters to us). Always
record WHY it matters to us, not just the raw fact.`,
    writerNote: `## How to write a world observation

Every row must name its relevance link — the fact AND the tie. Example shape:
"<external fact> — <why it matters> (relevant to <the specific business/human row
it touches>)." e.g. "Diesel spot price up ~12% this month — raises fuel cost for
route-based delivery work (relevant to this human's business)." NOT just "diesel
prices rose."
- level — L3 for the raw external fact (it happened / is so); L1 for your reasoned
  read of how it affects this human/business, with basis. Rarely L2.
- basis / evidence — where the fact came from AND which business/human row it
  connects to.
Re-check relevance before writing: if you cannot point to a specific human or
business observation it touches, discard it.`,
  },
  environment: {
    domain:       'environment',
    subjectLabel: 'the Sulla Desktop environment and host machine',
    focus: `Observe the SULLA DESKTOP ENVIRONMENT and the HOST MACHINE that runs
it — the technical substrate the agent operates in. Record ONLY what was DIRECTLY
OBSERVED and CONFIRMED this conversation (a command ran and you saw the result, a
path existed, a build passed or failed) — never guesses about how the environment
probably works.

Two things belong here:
1. Environment FACTS — confirmed truths about the machine, OS, filesystem paths,
   installed tools, services, networking, the credentials mechanism, VM-vs-host
   boundaries, versions, and limits. (e.g. "the app build cannot run in the Lima
   VM — its toolchain is host-only; it must build on the macOS host.")
2. PROCEDURAL lessons (skills-in-the-making) — a concrete approach that was
   CONFIRMED to work or CONFIRMED to fail here, with what and why, plus repeatable
   processes done often. (e.g. "to push a file to a branch: edit locally then
   update it through the GitHub tool — raw git push fails because the token is
   autofill-protected.")

categories: fact | tool | path | build | limit | method | anti-pattern | process.
This domain is the seedbed for crafting environment-specific skills, so a clean
confirmed method or a repeatable process is high-value.`,
    writerNote: `## How to write an environment observation

CONFIRMED-ONLY. If you did not directly observe it succeed or fail this
conversation, do not write it — the environment domain must stay trustworthy
enough to build skills from.
- level — L3 for something directly observed and confirmed (ran it, saw the
  result); L2 for a technical fact strongly implied by evidence but not directly
  confirmed; L1 for a conclusion/generalization ("this is our standard deploy
  path", "we do X often — skill candidate"), always with basis.
- category — one of: fact | tool | path | build | limit | method | anti-pattern
  | process.
- content — ONE sentence: the fact, or the method AND its outcome/why. For a
  process, name what makes it repeatable.
- evidence / basis — the command, path, error, or turn where you observed it.
A method that worked once cleanly is worth recording; a method that FAILED is
worth just as much — it stops the next chat repeating it. Flag repeatable
processes (seen 3+ times or clearly routine) as skill candidates.`,
  },
  projects: {
    domain:       'projects',
    subjectLabel: 'the internal projects and project-management system',
    focus: `Observe the INTERNAL PROJECTS and the project-management system that
tracks them — durable facts about what is being built and how the work is
organized. NOT this turn's task status: live task/epic state lives in the
structured Projects work-state store (the \`sulla project/*\` tools), not here.
- project: what a project/product is — its goal, scope, owner, current phase
- structure: how it is organized — epics, workstreams, repos, environments
- priority: what is being pushed, protected, or deprioritized right now
- decision: durable directions/decisions taken on a project
- process: release / build / deploy processes and conventions for a project
- relationship: how projects, repos, teams, and people connect
- blocker: standing constraints or dependencies between projects

Record what stays true across chats about a project, not "task 123 moved to
done" — that belongs in the structured Projects work-state store.`,
    writerNote: `## Certainty for project facts

The SUBJECT is a project or the PM system — personal facts belong to the human
domain, and LIVE task status belongs in the structured Projects store (via the
\`sulla project/*\` tools), never here. Name the project each row is about.
- L3 — the human stated it about a project directly ("Ripple Core ships behind a
  subscription gate").
- L2 — established from the conversation / work evidence, not stated outright;
  set basis to the evidence.
- L1 — a conclusion you reasoned about a project ("this project is release-gated
  on human review", "these two repos always move together"), always with basis.`,
  },
};

/**
 * Build the writer prompt for a domain observer. The discipline is the
 * SAME for every domain — record stated facts first (L3), then derived
 * facts (L2), then reasoned conclusions (L1, always with their basis) —
 * only the focus block changes.
 */
function buildIdentityObserverPrompt(cfg: IdentityObserverDomainConfig): string {
  return `You are the focused identity OBSERVER for ${ cfg.subjectLabel } (domain: ${ cfg.domain }).

CRITICAL: You are NOT the primary agent. You do NOT execute tasks, answer
questions, browse websites, call APIs, or do anything the user asked for.
Another agent handles that. You ONLY manage ${ cfg.domain } identity observations.

${ cfg.focus }

## Certainty levels — the core discipline

Work in this order, and NEVER inflate a level:
1. L3 — STATED FACTS first. Record anything ${ cfg.subjectLabel } directly
   stated about themselves in this conversation. These are ground truth.
2. L2 — DERIVED FACTS second. Things clearly established by conversation
   evidence without being stated outright. Set basis to the evidence.
3. L1 — CONCLUSIONS last. Reasoned judgments built from L3/L2 facts —
   personality reads, style, habits inferred over time. Set basis to the
   facts you reasoned from. Use logic; do not speculate from nothing.

If new evidence PROMOTES a fact (an L1 conclusion is later stated outright),
update the existing row to the higher level via its id. If evidence
contradicts a row, archive it (remove_identity_observation — soft-archive,
never hard-delete) and record the corrected fact.

## Workflow

BEFORE calling add_identity_observation for any new observation:
- Call search_identity_observations with the key topic/phrase to check for
  existing similar entries in the ${ cfg.domain } domain.
- If a similar entry exists, UPDATE it via add_identity_observation using
  its existing id rather than creating a duplicate.
- Only INSERT a fresh entry when nothing similar is found.

Each observation is ONE concise sentence with its context, a level, and a
category. Include why, not just what, when the reason matters.

If nothing about ${ cfg.subjectLabel } was revealed this conversation, finish
immediately — most task-focused turns need NO writes.

Do NOT:
- Try to complete the user's task
- Record task/project state (the general observation writer owns that)
- Record facts about other domains
- Search for tools, APIs, or integrations${ cfg.writerNote ? `\n\n${ cfg.writerNote }` : '' }`;
}

/**
 * Heartbeat native toolset — the slim primary set MINUS the interactive
 * `ask_user_question` tool. The heartbeat runs autonomously on the `heartbeat`
 * channel with no human watching, so a blocking question card would render
 * nowhere and deadlock the loop. Pinning this as the heartbeat's
 * `allowedToolNames` routes it through BaseNode's strict tool path (no dynamic
 * injection of ask_user_question). Full capability is retained — every other
 * tool is still reached via `browse_tools` + `exec`.
 */
const HEARTBEAT_TOOLS: string[] = [
  'browse_tools',
  'exec',
  'read_file',
  'write_file',
];

const SUBCONSCIOUS_ENVIRONMENT_ANCHOR = `## Sulla Desktop environment

You are running inside Sulla Desktop. The Sulla CLI is the canonical tool
surface for platform operations. Existing tools usually already exist, so do not
invent new scripts, integrations, or workflow formats when a cataloged Sulla tool
can do the job.

Primary/operator agents can discover tools with:
\`sulla meta/browse_tools '{"query":"..."}'\`

Sulla's bundled docs describe the environment, tool catalog, workflows,
functions, sub-agents, and common operating procedures. When environment/tool
knowledge matters, use that context instead of guessing.

Sulla has an internal Projects system — the single source of truth for work
state (projects → epics → tasks → comments), reached through the \`sulla
project/*\` tools. It is where commitments, outcomes, and gate changes are
recorded; there is never a separate ad-hoc task list.

This context does not expand your authority. If you are a subconscious observer,
stay within your assigned prompt and allowed tools; observe and write memory only
when your prompt says to do so.`;

// ============================================================================
// SUBCONSCIOUS MIDDLEWARE PROMPTS
// ============================================================================

const OBSERVATION_AGENT_PROMPT = `You are the observation WRITER process for an AI agent.

CRITICAL: You are NOT the primary agent. You OBSERVE the conversation — you do
NOT act in it. You do NOT execute tasks, answer questions, browse websites, call
APIs, write files, run commands, edit code, or do anything the user asked for.
You have NO file, shell, or code tools and must never try to acquire or use any.
Another agent does the work. You ONLY read the conversation and manage
observation rows.

Your ONLY jobs:
1. Review the conversation for important facts, decisions, preferences, or
   commitments that should be remembered long-term for all conversations.

   BEFORE calling add_observational_memory for any new observation:
   - Call search_observations with the key topic/phrase to check for existing
     similar entries.
   - If a similar entry exists, UPDATE it via add_observational_memory using
     its existing id (to update in-place) rather than creating a duplicate.
   - Only INSERT a fresh entry when nothing similar is found.

2. Review current observations for anything stale or superseded. Use
   remove_observational_memory (soft-archive, never hard-delete) for entries
   that are no longer accurate or have been superseded by a newer one.

3. Maintain the WORKBOARD (Postgres project_projects / work_epics / work_tasks —
   the agent's single project-state store). From THIS conversation only, extract:
   - Commitments made ("I'll build X", "next step is Y") -> search_project_items
     first; update_task the existing row or create_task if none matches.
     Never invent a parallel markdown task list.
   - Outcomes shipped (something merged, pushed, filed, fixed, verified,
     decided) -> update_task status=done (or in_progress if partial) and
     add_task_comment: date — what shipped — what it changed.
   - A gate opening or closing (approval given, PR merged, decision made) ->
     update_task the matching row (blocked -> in_progress / done) and comment.
   ~/sulla/ledger/ is a historical archive — do not write LEDGER.md / OUTCOMES.md.
   Skip entirely when the conversation contains no commitment, outcome, or
   gate change — most turns need NO Projects write.

When saving new observations, include why certain decisions were made (not just what). Like:

"Google Maps loaded with roofers — scrolled 3x, collected 5 results"
"Twenty account ID: local_merchant_protocol — verified working 2m ago"

If nothing needs to change, finish immediately.

Do NOT:
- Try to complete the user's task or take any action in the conversation
- Write files, run shell commands, or edit code — you have no tools for this and
  must not attempt it
- Search for tools, APIs, or integrations
- Run curl commands or interact with services
- Do anything beyond reading the conversation and managing observation rows

Priority levels:
- 🔴 Critical: identity, strong preferences/goals, promises, deal-breakers
- 🟡 Valuable: decisions, patterns, progress markers
- ⚪ Low: minor/transient items (use sparingly)`;

const OBSERVATION_RECALL_PROMPT = `You are the observation RECALL process for an AI agent.

CRITICAL: You are READ-ONLY. You NEVER write, insert, update, or delete observations.
You only search and list — then return a filtered, compact summary.

## Your job

Read the recent conversation context. Based on what the human is asking about
or what task is in progress, search the observations table for entries that
are relevant OR might be relevant to the current context.

Rules:
- Call search_observations with the key topic/phrase from the conversation.
- Optionally call list_observations to see high-priority entries.
- Return ONLY observations that are relevant or possibly relevant.
- Format each result as: \`[id] priority date — content\`
- If nothing is relevant, return an empty string — do NOT pad with filler.
- Do NOT narrate your process. Output only the filtered observation lines.

Speed: the primary agent BLOCKS until you finish. Tool calls in the SAME
response run in PARALLEL — issue every search you need (different phrasings,
plus list_observations) as ONE batch in your first response, then answer.
Do not search one term at a time across multiple rounds.

Be selective: a 5-entry relevant subset is better than 30 entries dumped verbatim.`;

function buildIdentityObservationRecallPrompt(cfg: IdentityObserverDomainConfig): string {
  return `You are the focused identity observation RECALL process for ${ cfg.subjectLabel } (domain: ${ cfg.domain }).

CRITICAL: You are READ-ONLY. You NEVER write, insert, update, or delete identity observations.
You only search and list — then return the observations relevant to the current conversation.

## Your job

Read the recent conversation context. Based on what the human is asking about,
what task is in progress, and what identity facts could help the primary
agent respond well, search the ${ cfg.domain } identity_observations table.

${ cfg.focus }

Rules:
- Call search_identity_observations with key topic/phrase variants from the conversation.
- Optionally call list_identity_observations when broad identity context is needed.
- Return ONLY observations that are relevant or possibly relevant to this turn.
- Format each result as: \`[id] L<level>·<category> date — content (basis: ...)\`
- If many observations are relevant, return many. If only a few matter, return a few.
- If nothing is relevant, return an empty string — do NOT pad with filler.
- Do NOT narrate your process. Output only the filtered observation lines.

Speed: the primary agent BLOCKS until you finish. Tool calls in the SAME
response run in PARALLEL — issue every search you need (different phrasings,
plus list_identity_observations if useful) as ONE batch in your first response,
then answer. Do not search one term at a time across multiple rounds.

Be selective by relevance, not by recency or a fixed count.`;
}
// ── Observation Recall: cache constants ──────────────────────────────────

const SUMMARIZER_PROMPT = `You are the memory compression process for an AI agent. Talk through
what you're doing — which messages look irrelevant, which have useful facts
worth keeping, and what you're compressing. Then provide your decisions as XML.

Each message below has a unique message_id in its metadata. Your job is to
remove information that is completely irrelevant to accomplishing the current
goal. Either remove irrelevant messages or summarize them down to the
important contextual facts.

For each message, decide:
- DELETE: if the message is completely irrelevant to the current goal
- SUMMARIZE: if the message has some relevant facts but is too verbose — compress it
- KEEP: if the message is important as-is (do nothing, don't list it)

Return your decisions as XML. Reference messages by their unique message_id (NOT by index
position — positions change between loops).

<DELETE>
  <MESSAGE id="msg_1743500000000_1" />
  <MESSAGE id="msg_1743500000000_4" />
</DELETE>
<SUMMARIZE>
  <MESSAGE id="msg_1743500000000_2">The compressed essential facts from this message.</MESSAGE>
  <MESSAGE id="msg_1743500000000_5">Key decision: user chose option B for the auth flow.</MESSAGE>
</SUMMARIZE>

Rules:
- Only delete or summarize — never add new messages.
- Preserve the most recent messages (last 5-10) as they contain active context.
- Focus compression on older messages in the conversation.
- If nothing needs to change, return empty tags: <DELETE></DELETE><SUMMARIZE></SUMMARIZE>
- System messages should never be deleted or summarized.
- Always use the message_id attribute, never reference messages by position.`;

const TOOL_RESULT_DIGESTER_PROMPT = `You are the tool-result digestion process for an AI agent. Stale tool
results from earlier in the conversation are about to be compressed so the
primary agent re-reads trusted citations instead of verbatim dumps. Talk
through what each result contains and what's worth keeping, then provide
your digests as XML.

Each tool result below is tagged with a unique tool_result_id. For EVERY
result, write a digest in trusted-citation style:
- What was run (tool name + key inputs/parameters)
- Key findings: concrete values, file paths, ids, counts, error messages
- Where the full output came from (file path, URL, command) so the primary
  agent can re-fetch it if truly needed

Return your digests as XML. Reference results by their tool_result_id (NOT
by position — positions change between loops).

<DIGEST>
  <RESULT id="toolu_abc123">file_search "auth flow" → 3 matches: src/auth/login.ts, src/auth/session.ts, docs/auth.md. login.ts owns the OAuth redirect. Re-run file_search to refresh.</RESULT>
  <RESULT id="toolu_def456">exec \`kubectl get pods\` → 12 pods running, 1 CrashLoopBackOff (redis-7d4f, restarts=14). Full output re-obtainable by re-running the command.</RESULT>
</DIGEST>

Rules:
- Digest EVERY tool result you were given — do not skip any.
- Preserve exact values: paths, ids, numbers, hashes, error strings. Never
  round, rename, or paraphrase identifiers.
- Never invent information that isn't in the original output.
- 1-4 sentences per digest. Dense, factual, no filler.
- If a result is an error, keep the error message verbatim.
- If nothing was given, return empty tags: <DIGEST></DIGEST>`;

// XML parsing for summarizer response handler — uses message IDs (strings)
const DELETE_BLOCK_REGEX = /<DELETE>([\s\S]*?)<\/DELETE>/i;
const SUMMARIZE_BLOCK_REGEX = /<SUMMARIZE>([\s\S]*?)<\/SUMMARIZE>/i;
const DELETE_MESSAGE_REGEX = /<MESSAGE\s+id="([^"]+)"\s*\/>/gi;
const SUMMARIZE_MESSAGE_REGEX = /<MESSAGE\s+id="([^"]+)">([\s\S]*?)<\/MESSAGE>/gi;

function parseSummarizerXML(text: string): { deletions: Set<string>; summaries: Map<string, string> } {
  const deletions = new Set<string>();
  const summaries = new Map<string, string>();

  const deleteBlock = DELETE_BLOCK_REGEX.exec(text);
  if (deleteBlock) {
    let match;
    DELETE_MESSAGE_REGEX.lastIndex = 0;
    while ((match = DELETE_MESSAGE_REGEX.exec(deleteBlock[1])) !== null) {
      deletions.add(match[1]);
    }
  }

  const summarizeBlock = SUMMARIZE_BLOCK_REGEX.exec(text);
  if (summarizeBlock) {
    let match;
    SUMMARIZE_MESSAGE_REGEX.lastIndex = 0;
    while ((match = SUMMARIZE_MESSAGE_REGEX.exec(summarizeBlock[1])) !== null) {
      summaries.set(match[1], match[2].trim());
    }
  }

  return { deletions, summaries };
}

// XML parsing for tool-result digester response handler — uses tool_use_ids
const DIGEST_BLOCK_REGEX = /<DIGEST>([\s\S]*?)<\/DIGEST>/i;
const DIGEST_RESULT_REGEX = /<RESULT\s+id="([^"]+)">([\s\S]*?)<\/RESULT>/gi;

function parseDigesterXML(text: string): Map<string, string> {
  const digests = new Map<string, string>();

  const digestBlock = DIGEST_BLOCK_REGEX.exec(text);
  if (digestBlock) {
    let match;
    DIGEST_RESULT_REGEX.lastIndex = 0;
    while ((match = DIGEST_RESULT_REGEX.exec(digestBlock[1])) !== null) {
      const digest = match[2].trim();
      if (digest) {
        digests.set(match[1], digest);
      }
    }
  }

  return digests;
}

/**
 * A stale tool_result block eligible for digestion.
 * Built by SubconsciousMiddleware, consumed by createToolResultDigester.
 */
export interface DigestibleToolResult {
  /** tool_use_id of the tool_result block in state.messages */
  toolUseId: string;
  /** Tool name if known (from message metadata) */
  toolName:  string;
  /** Serialized character count of the original block content */
  charCount: number;
  /** Text rendering of the block content (image data omitted) */
  text:      string;
}

export const GraphRegistry = {
  /**
   * Get existing graph for thread, or create new if not found.
   */
  get(threadId: string): {
    graph: Graph<any>;
    state: BaseThreadState;
  } | null {
    return registry.get(threadId) ?? null;
  },

  /**
   * Create a brand new graph + state (always fresh threadId).
   * Use when user explicitly wants "New Conversation".
   */
  createNew: async function(wsChannel: string, options?: { isTrustedUser?: 'trusted' | 'untrusted' | 'verify'; userVisibleBrowser?: boolean }): Promise<{
    graph:    Graph<any>;
    state:    BaseThreadState;
    threadId: string;
  }> {
    const threadId = nextThreadId();
    const graph = createAgentGraph();
    const state = await buildAgentState(wsChannel, threadId, options);

    registry.set(threadId, { graph, state });
    return { graph, state, threadId };
  },

  /**
   * Get or create Heartbeat graph (formerly Overlord).
   */
  getOrCreateOverlordGraph: async function(wsChannel: string, prompt?: string): Promise<{
    graph: Graph<AgentGraphState>;
    state: AgentGraphState;
  }> {
    // One conversation per heartbeat cycle: never resume a cached thread.
    // A long-lived thread pins the system prompt to whatever was built when
    // the conversation started (prompt updates never reach the model) and
    // accumulates self-reinforcing history. Continuity lives in recall,
    // observations, and the bookkeeping files — not chat scrollback.
    const graph = createHeartbeatGraph();
    const state = await buildHeartbeatState(wsChannel, prompt ?? '');

    // Keep the latest entry for observability/recovery consumers.
    registry.set(wsChannel, { graph, state });
    return { graph, state };
  },

  /**
   * Get or create AgentGraph — the standard graph for all tasks.
   * @param options Optional graph options that configure prompt directives, tool blocking, etc.
   */
  getOrCreate: async function(wsChannel: string, threadId: string, options?: { isTrustedUser?: 'trusted' | 'untrusted' | 'verify'; userVisibleBrowser?: boolean }): Promise<{
    graph: Graph<AgentGraphState>;
    state: AgentGraphState;
  }> {
    if (registry.has(threadId)) {
      console.log(`[GraphRegistry] getOrCreate() — cache HIT for threadId="${ threadId }"`);
      return Promise.resolve(registry.get(threadId)!);
    }

    // Try to restore from ThreadStateStore (Redis / in-memory fallback)
    const saved = await loadThreadState(threadId);
    if (saved) {
      console.log(`[GraphRegistry] getOrCreate() — restored from ThreadStateStore for threadId="${ threadId }", messages=${ saved.messages.length }`);
      const graph = createAgentGraph();
      // Ensure wsChannel is current (may have changed)
      saved.metadata.wsChannel = wsChannel;
      registry.set(threadId, { graph, state: saved });
      return { graph, state: saved as AgentGraphState };
    }

    console.log(`[GraphRegistry] getOrCreate() — cache MISS, creating new graph for agentId="${ wsChannel }", threadId="${ threadId }"`);
    const graph = createAgentGraph();
    console.log(`[GraphRegistry] getOrCreate() — agent graph created, building state...`);
    const state = await buildAgentState(wsChannel, threadId, options);
    console.log(`[GraphRegistry] getOrCreate() — state built: model="${ state.metadata.llmModel }", local=${ state.metadata.llmLocal }, agentName="${ state.metadata.agent?.name || '(none)' }"`);

    registry.set(threadId, { graph, state });
    return { graph, state };
  },

  // Aliases — all point to AgentGraph now
  getOrCreateSkillGraph: async function(wsChannel: string, threadId: string, options?: { isTrustedUser?: 'trusted' | 'untrusted' | 'verify'; userVisibleBrowser?: boolean }) {
    return this.getOrCreate(wsChannel, threadId, options);
  },

  getOrCreateAgentGraph: async function(wsChannel: string, threadId: string, options?: { isTrustedUser?: 'trusted' | 'untrusted' | 'verify'; userVisibleBrowser?: boolean }) {
    return this.getOrCreate(wsChannel, threadId, options);
  },

  getOrCreateGeneralGraph: async function(wsChannel: string, threadId: string, options?: { isTrustedUser?: 'trusted' | 'untrusted' | 'verify'; userVisibleBrowser?: boolean }) {
    return this.getOrCreate(wsChannel, threadId, options);
  },

  /**
   * Create a Subconscious graph — minimal multi-turn tool-calling loop.
   * Does not cache in registry (each invocation is ephemeral).
   */
  createSubconscious: async function(opts: {
    systemPrompt:           string;
    tools:                  string[];
    userMessage:            string;
    messages?:              any[];
    maxIterations?:         number;
    temperature?:           number;
    format?:                'json';
    maxTokens?:             number;
    responseHandler?:       (response: string, state: BaseThreadState) => void;
    parentAbortSignal?:     any;
    agentLabel?:            string;
    parentConversationId?:  string;
    parentWsChannel?:       string;
    workflowNodeId?:        string;
    workflowParentChannel?: string;
  }): Promise<{
      graph:    Graph<BaseThreadState>;
      state:    BaseThreadState;
      threadId: string;
    }> {
    const graph = createSubconsciousGraph();
    const state = await buildSubconsciousState(opts);
    return { graph, state, threadId: state.metadata.threadId };
  },

  /**
   * Create a Summarizer graph — single-pass conversation compression.
   * Uses a responseHandler to parse XML delete/summarize instructions
   * and apply them to the original messages stored on metadata.
   */
  createSummarizer: async function(parentState: BaseThreadState): Promise<{
    graph:    Graph<BaseThreadState>;
    state:    BaseThreadState;
    threadId: string;
  }> {
    // Ensure every message has a unique ID for stable referencing across loops.
    // Store the ID on the ChatMessage.id field AND inject it visibly into the
    // content so the LLM can see and reference it in its XML response.
    const originalMessages = parentState.messages.map((msg: any) => {
      const id = msg.id || nextMessageId();
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      return {
        ...msg,
        id,
        content:  `[message_id: ${ id }]\n${ content }`,
        metadata: { ...(msg.metadata || {}), message_id: id },
      };
    });

    return this.createSubconscious({
      systemPrompt:           SUMMARIZER_PROMPT,
      tools:                  SUMMARIZER_TOOLS,
      userMessage:            'Review the conversation above and determine which messages to delete or summarize.',
      messages:               originalMessages,
      agentLabel:             'summarizer',
      parentWsChannel:        String(parentState.metadata.wsChannel || ''),
      parentConversationId:   (parentState.metadata as any).threadId || (parentState.metadata as any).conversationId,
      parentAbortSignal:    (parentState.metadata as any).options?.abort,
      workflowNodeId:         (parentState.metadata as any).workflowNodeId,
      workflowParentChannel:  (parentState.metadata as any).workflowParentChannel,
      responseHandler(response: string, state: BaseThreadState) {
        let actions: { deletions: Set<string>; summaries: Map<string, string> };
        try {
          actions = parseSummarizerXML(response);
        } catch (err) {
          console.warn('[Summarizer] Failed to parse XML response:', err instanceof Error ? err.message : err);
          return;
        }
        if (actions.deletions.size === 0 && actions.summaries.size === 0) return;

        // Rebuild from the original parent messages (clean content, no
        // injected [message_id:] prefixes). originalMessages and
        // parentState.messages are 1:1 — use the tagged ID with the
        // clean parent message.
        const parentMessages = parentState.messages;
        const result: any[] = [];
        for (let i = 0; i < originalMessages.length; i++) {
          const msgId = originalMessages[i].id;
          const cleanMsg = parentMessages[i] || originalMessages[i];
          if (cleanMsg.role === 'system') { result.push({ ...cleanMsg, id: msgId }); continue }
          if (actions.deletions.has(msgId)) continue;
          if (actions.summaries.has(msgId)) {
            result.push({
              ...cleanMsg,
              id:       msgId,
              content:  actions.summaries.get(msgId),
              metadata: { ...(cleanMsg.metadata || {}), message_id: msgId, _summarized: true, timestamp: Date.now() },
            });
            continue;
          }
          result.push({ ...cleanMsg, id: msgId });
        }

        (state.metadata as any).compressedMessages = result;
        (state.metadata as any).deletedCount = actions.deletions.size;
        (state.metadata as any).summarizedCount = actions.summaries.size;
        console.log(`[Summarizer] Compressed: deleted ${ actions.deletions.size }, summarized ${ actions.summaries.size }, kept ${ result.length } of ${ originalMessages.length }`);
      },
    });
  },

  /**
   * Create a Tool-Result Digester graph — single-pass compression of stale
   * tool_result blocks into trusted-citation digests. Uses a responseHandler
   * to parse XML <DIGEST> instructions into a tool_use_id → digest map; the
   * caller (SubconsciousMiddleware) applies the replacements to the live
   * state in one batch.
   *
   * The eligible tool results are rendered directly into the user message
   * rather than passing the full conversation — the digester only needs the
   * stale outputs themselves plus the current goal for relevance.
   */
  createToolResultDigester: async function(parentState: BaseThreadState, eligible: DigestibleToolResult[]): Promise<{
    graph:    Graph<BaseThreadState>;
    state:    BaseThreadState;
    threadId: string;
  }> {
    // Current goal — the last real user message — so the digester knows
    // which values matter for the active task.
    const lastUserMsg = [...parentState.messages].reverse().find(
      (m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.trim(),
    );
    const goalText = lastUserMsg ? String(lastUserMsg.content).slice(0, 600) : '(unknown)';

    const rendered = eligible
      .map(r => `[tool_result_id: ${ r.toolUseId } | tool: ${ r.toolName } | ~${ r.charCount } chars]\n${ r.text }`)
      .join('\n\n---\n\n');

    return this.createSubconscious({
      systemPrompt:           TOOL_RESULT_DIGESTER_PROMPT,
      tools:                  TOOL_RESULT_DIGESTER_TOOLS,
      userMessage:            `Current goal:\n${ goalText }\n\nStale tool results to digest:\n\n${ rendered }\n\nDigest every tool result above and return your <DIGEST> XML.`,
      agentLabel:             'tool-result-digester',
      parentWsChannel:        String(parentState.metadata.wsChannel || ''),
      parentConversationId:   (parentState.metadata as any).threadId || (parentState.metadata as any).conversationId,
      parentAbortSignal:      (parentState.metadata as any).options?.abort,
      workflowNodeId:         (parentState.metadata as any).workflowNodeId,
      workflowParentChannel:  (parentState.metadata as any).workflowParentChannel,
      responseHandler(response: string, state: BaseThreadState) {
        let digests: Map<string, string>;
        try {
          digests = parseDigesterXML(response);
        } catch (err) {
          console.warn('[ToolResultDigester] Failed to parse XML response:', err instanceof Error ? err.message : err);
          return;
        }
        if (digests.size === 0) return;

        (state.metadata as any).toolResultDigests = digests;
        console.log(`[ToolResultDigester] Parsed ${ digests.size } digests for ${ eligible.length } eligible tool results`);
      },
    });
  },

  /**
   * Create an Observation Agent (writer) graph — reviews conversation for
   * important facts to save to the observations table. Deduplicates via
   * search_observations before inserting, and soft-archives stale entries.
   * The agent reads its own context from the DB — no pre-loaded blob needed.
   */
  createObservationAgent: async function(parentState: BaseThreadState): Promise<{
    graph:    Graph<BaseThreadState>;
    state:    BaseThreadState;
    threadId: string;
  }> {
    const graph = createSubconsciousGraph();
    const state = await buildSubconsciousState({
      systemPrompt:           OBSERVATION_AGENT_PROMPT,
      tools:                  OBSERVATION_AGENT_TOOLS,
      userMessage:            'Review this conversation. Search for existing observations before adding any new ones (update instead of duplicate). Soft-archive stale or superseded entries. Update identity files if warranted. Write any commitments/outcomes/gate-changes from this conversation to the outcome ledger (~/sulla/ledger/). If nothing needs to change, finish immediately.',
      messages:               [...parentState.messages],
      // Wider than recall — the writer mines the conversation for facts —
      // but still bounded; the summarizer compacts anything older anyway.
      contextWindow:          30,
      parentAbortSignal:      (parentState.metadata as any).options?.abort,
      agentLabel:             'observation',
      parentWsChannel:        String(parentState.metadata.wsChannel || ''),
      parentConversationId:   (parentState.metadata as any).threadId || (parentState.metadata as any).conversationId,
      workflowNodeId:         (parentState.metadata as any).workflowNodeId,
      workflowParentChannel:  (parentState.metadata as any).workflowParentChannel,
    });
    return { graph, state, threadId: state.metadata.threadId };
  },

  /**
   * Create a focused Identity Observer (writer) graph for one domain of
   * ~/sulla/identity/ (human first). Records stated facts (L3), then derived
   * facts (L2), then reasoned conclusions (L1) into identity_observations.
   * Reusable template: pass a different registered domain to observe it —
   * see IDENTITY_OBSERVER_DOMAINS.
   */
  createIdentityObserver: async function(parentState: BaseThreadState, domain = 'human'): Promise<{
    graph:    Graph<BaseThreadState>;
    state:    BaseThreadState;
    threadId: string;
  }> {
    const cfg = IDENTITY_OBSERVER_DOMAINS[domain];
    if (!cfg) throw new Error(`Unknown identity observer domain: ${ domain }`);

    const graph = createSubconsciousGraph();
    const state = await buildSubconsciousState({
      systemPrompt:           buildIdentityObserverPrompt(cfg),
      tools:                  IDENTITY_OBSERVER_TOOLS,
      userMessage:            `Review this conversation for facts about ${ cfg.subjectLabel }. Record stated facts (L3) first, then derived facts (L2), then reasoned conclusions (L1, with their basis). Search for existing entries before adding (update instead of duplicate); promote levels when evidence upgrades a fact; soft-archive contradicted rows. If nothing about ${ cfg.subjectLabel } was revealed, finish immediately.`,
      messages:               [...parentState.messages],
      // Same window as the general writer — it mines conversation for facts.
      contextWindow:          30,
      parentAbortSignal:      (parentState.metadata as any).options?.abort,
      agentLabel:             `identity-observer-${ cfg.domain }`,
      parentWsChannel:        String(parentState.metadata.wsChannel || ''),
      parentConversationId:   (parentState.metadata as any).threadId || (parentState.metadata as any).conversationId,
      workflowNodeId:         (parentState.metadata as any).workflowNodeId,
      workflowParentChannel:  (parentState.metadata as any).workflowParentChannel,
    });
    return { graph, state, threadId: state.metadata.threadId };
  },

  /**
   * Create an Identity Observation Recall graph — read-only search/list of
   * domain-keyed identity observations. The recall agent selects observations
   * relevant to the current conversation; it is not a top-N recency dump.
   */
  createIdentityObservationRecall: async function(parentState: BaseThreadState, domain = 'human'): Promise<{
    graph:    Graph<BaseThreadState>;
    state:    BaseThreadState;
    threadId: string;
  }> {
    const cfg = IDENTITY_OBSERVER_DOMAINS[domain];
    if (!cfg) throw new Error(`Unknown identity observer domain: ${ domain }`);

    const graph = createSubconsciousGraph();
    const state = await buildSubconsciousState({
      systemPrompt:           buildIdentityObservationRecallPrompt(cfg),
      tools:                  IDENTITY_OBSERVATION_RECALL_TOOLS,
      userMessage:            `Read the recent conversation context and return only ${ cfg.domain } identity observations that are relevant or possibly relevant to what is happening now. Return compact lines only — nothing if nothing is relevant.`,
      messages:               [...parentState.messages],
      contextWindow:          20,
      parentAbortSignal:      (parentState.metadata as any).options?.abort,
      agentLabel:             `identity-observation-recall-${ cfg.domain }`,
      parentWsChannel:        String(parentState.metadata.wsChannel || ''),
      parentConversationId:   (parentState.metadata as any).threadId || (parentState.metadata as any).conversationId,
      workflowNodeId:         (parentState.metadata as any).workflowNodeId,
      workflowParentChannel:  (parentState.metadata as any).workflowParentChannel,
    });
    return { graph, state, threadId: state.metadata.threadId };
  },

  /**
   * Create an Observation Recall graph — read-only search of the observations
   * table to surface entries relevant to the current conversation context.
   * Returns compact `[id] priority date — content` lines, or null when nothing
   * is relevant.
   */
  createObservationRecall: async function(parentState: BaseThreadState): Promise<{
    graph:    Graph<BaseThreadState>;
    state:    BaseThreadState;
    threadId: string;
  }> {
    const graph = createSubconsciousGraph();
    const state = await buildSubconsciousState({
      systemPrompt:           OBSERVATION_RECALL_PROMPT,
      tools:                  OBSERVATION_RECALL_TOOLS,
      userMessage:            'Read the recent conversation context and return only the observations that are relevant or possibly relevant to what the human is asking about. Return compact lines only — nothing if nothing is relevant.',
      messages:               [...parentState.messages],
      // Recent tail only: obs-recall reads the latest exchange, then searches the table.
      contextWindow:          20,
      parentAbortSignal:      (parentState.metadata as any).options?.abort,
      agentLabel:             'observation-recall',
      parentWsChannel:        String(parentState.metadata.wsChannel || ''),
      parentConversationId:   (parentState.metadata as any).threadId || (parentState.metadata as any).conversationId,
      workflowNodeId:         (parentState.metadata as any).workflowNodeId,
      workflowParentChannel:  (parentState.metadata as any).workflowParentChannel,
    });
    return { graph, state, threadId: state.metadata.threadId };
  },

  delete(threadId: string): void {
    registry.delete(threadId);
  },

  clearAll(): void {
    registry.clear();
  },

  updateRuntimeFlags(threadId: string, flags: { n8nLiveEventsEnabled?: boolean }): boolean {
    const record = registry.get(threadId);
    if (!record) {
      return false;
    }

    if (typeof flags.n8nLiveEventsEnabled === 'boolean') {
      (record.state.metadata as any).n8nLiveEventsEnabled = flags.n8nLiveEventsEnabled;
    }

    return true;
  },

  updateRuntimeFlagsByStateThreadId(threadId: string, flags: { n8nLiveEventsEnabled?: boolean }): number {
    let updatedCount = 0;

    for (const record of registry.values()) {
      const stateThreadId = String((record.state.metadata as any)?.threadId || '').trim();
      if (!stateThreadId || stateThreadId !== threadId) {
        continue;
      }

      if (typeof flags.n8nLiveEventsEnabled === 'boolean') {
        (record.state.metadata as any).n8nLiveEventsEnabled = flags.n8nLiveEventsEnabled;
      }

      updatedCount += 1;
    }

    return updatedCount;
  },

  /**
   * Best-effort lookup of the live sulla-desktop chat the user is looking
   * at. Used by the interactive `ask_user_question` tool when it is invoked
   * outside a ToolExecutor context (CLI / HTTP) and needs a channel + thread
   * to render its card into.
   *
   * Prefers graphs whose wsChannel is `sulla-desktop` and that still look
   * "alive" (not waitingForUser with a completed cycle). Falls back to the
   * most recently registered sulla-desktop entry, then any agent graph.
   */
  findActiveChat(): { wsChannel: string; threadId: string; state: BaseThreadState } | null {
    const preferred: Array<{ wsChannel: string; threadId: string; state: BaseThreadState; score: number }> = [];
    for (const [key, record] of registry.entries()) {
      const state = record.state;
      const wsChannel = String(state?.metadata?.wsChannel || '').trim();
      const threadId = String(state?.metadata?.threadId || key || '').trim();
      if (!wsChannel || !threadId) continue;
      // Skip pure subconscious / heartbeat-only graphs — they are not the chat UI.
      if (wsChannel === 'heartbeat' || wsChannel.startsWith('subconscious')) continue;
      let score = 0;
      if (wsChannel === 'sulla-desktop') score += 100;
      if (!(state.metadata as any)?.cycleComplete) score += 10;
      if ((state.metadata as any)?.hadUserMessages) score += 5;
      // Prefer non-sub-agent primary graphs.
      if (!(state.metadata as any)?.isSubAgent) score += 20;
      preferred.push({ wsChannel, threadId, state, score });
    }
    if (preferred.length === 0) return null;
    preferred.sort((a, b) => b.score - a.score);
    const best = preferred[0];
    return { wsChannel: best.wsChannel, threadId: best.threadId, state: best.state };
  },
};

const DEFAULT_AGENT_FALLBACK = 'chat-controller';

/**
 * Resolve the default agent ID from settings, falling back to 'chat-controller'.
 */
export async function getDefaultAgentId(): Promise<string> {
  console.log(`[GraphRegistry] getDefaultAgentId() — resolving...`);
  const id = await SullaSettingsModel.get('defaultAgentId', 'sulla-desktop');
  if (id) {
    console.log(`[GraphRegistry] getDefaultAgentId() — found setting: "${ id }"`);
    return id;
  }

  // If no setting yet, check if chat-controller exists
  if (findAgentDir(DEFAULT_AGENT_FALLBACK)) {
    console.log(`[GraphRegistry] getDefaultAgentId() — no setting, using fallback dir: "${ DEFAULT_AGENT_FALLBACK }"`);
    return DEFAULT_AGENT_FALLBACK;
  }

  // Last resort: pick the first agent directory that exists
  for (const agentsRoot of resolveAllAgentsDirs()) {
    console.log(`[GraphRegistry] getDefaultAgentId() — scanning agents root: "${ agentsRoot }"`);
    if (fs.existsSync(agentsRoot)) {
      const entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
      const firstAgent = entries.find(e => e.isDirectory());
      if (firstAgent) {
        console.log(`[GraphRegistry] getDefaultAgentId() — picked first agent dir: "${ firstAgent.name }"`);
        return firstAgent.name;
      }
    }
  }

  console.log(`[GraphRegistry] getDefaultAgentId() — no agents found, hard fallback: "${ DEFAULT_AGENT_FALLBACK }"`);
  return DEFAULT_AGENT_FALLBACK;
}

/**
 * Resolve the agent ID for a specific trigger type.
 * Checks triggerAgentMap first, then falls back to getDefaultAgentId().
 */
export async function getAgentIdForTrigger(triggerType: string): Promise<string> {
  const triggerMap: Record<string, string> = {
    'sulla-desktop': 'sulla-desktop',
    workbench:       'sulla-desktop',
    heartbeat:       'dreaming-protocol',
  };

  const assigned = triggerMap[triggerType];
  if (assigned) {
    const agentDir = findAgentDir(assigned);
    const exists = !!agentDir;
    console.log(`[GraphRegistry] getAgentIdForTrigger() — trigger "${ triggerType }" mapped to "${ assigned }", dir exists=${ exists }`);
    // Return the mapped ID whether or not the dir exists — buildAgentState
    // gracefully handles missing agent dirs (runs with default prompts/tools).
    return assigned;
  }

  console.log(`[GraphRegistry] getAgentIdForTrigger() — no mapping for "${ triggerType }", using triggerType as agentId`);
  return triggerType || 'sulla-desktop';
}

let threadCounter = 0;
let messageCounter = 0;

export function nextThreadId(): string {
  return `thread_${ Date.now() }_${ ++threadCounter }`;
}

export function nextMessageId(): string {
  return `msg_${ Date.now() }_${ ++messageCounter }`;
}

async function buildHeartbeatState(wsChannel: string, prompt: string): Promise<AgentGraphState> {
  const heartbeatProvider = await SullaSettingsModel.get('heartbeatProvider', 'default');

  // Resolve provider to model/local flags
  let llmModel: string;
  let llmLocal: boolean;

  if (heartbeatProvider === 'default' || heartbeatProvider === 'ollama') {
    llmModel = await getCurrentModel();
    llmLocal = false;
  } else {
    llmLocal = false;
    try {
      const { getIntegrationService } = await import('./IntegrationService');
      const integrationService = getIntegrationService();
      const values = await integrationService.getFormValues(heartbeatProvider);
      const modelVal = values.find((v: { property: string; value: string }) => v.property === 'model');
      llmModel = modelVal?.value || '';
    } catch {
      llmModel = await SullaSettingsModel.get('remoteModel', '');
    }
  }

  const now = Date.now();
  const threadId = `heartbeat_${ now }`;

  // Load agent config for the heartbeat channel (dreaming-protocol)
  const agentConfig = await loadAgentConfig(wsChannel);

  // Pre-resolve the heartbeat's native tool schemas. Setting both `llmTools`
  // (top-level, read by normalizedChat) and `allowedToolNames` (metadata,
  // forwarded by AgentNode) routes the heartbeat through BaseNode's strict
  // tool path — it gets exactly HEARTBEAT_TOOLS and never the injected
  // interactive tools that can only deadlock on the unwatched channel.
  const llmTools = await Promise.all(
    HEARTBEAT_TOOLS.map(name => toolRegistry.convertToolToLLM(name)),
  );

  const state: AgentGraphState = {
    messages: [{
      role:     'user',
      content:  prompt,
      metadata: { source: 'heartbeat' },
    }],
    metadata: {
      action:               'use_tools',
      threadId,
      wsChannel,
      cycleComplete:        false,
      waitingForUser:       false,
      isSubAgent:           false,
      subAgentDepth:        0,
      llmModel,
      llmLocal,
      options:              {},
      currentNodeId:        'input_handler',
      consecutiveSameNode:  0,
      iterations:           0,
      revisionCount:        0,
      maxIterationsReached: false,
      memory:               {
        knowledgeBaseContext: '',
        chatSummariesContext: '',
      },
      subGraph: {
        state:    'completed',
        name:     'hierarchical',
        prompt:   '',
        response: '',
      },
      finalSummary:         '',
      finalState:           'running',
      n8nLiveEventsEnabled: false,
      returnTo:             null,

      agent:          agentConfig,
      agentLoopCount: 0,
    },
  };

  // llmTools rides on the top-level state (read by normalizedChat as
  // `(state as any).llmTools`); allowedToolNames lives on metadata (forwarded
  // by AgentNode). Both are `as any` fields, matching buildSubconsciousState.
  (state as any).llmTools = llmTools;
  (state.metadata as any).allowedToolNames = HEARTBEAT_TOOLS;

  return state;
}

async function buildAgentState(wsChannel: string, threadId?: string, graphOpts?: { isTrustedUser?: 'trusted' | 'untrusted' | 'verify'; userVisibleBrowser?: boolean }): Promise<AgentGraphState> {
  const id = threadId ?? nextThreadId();

  console.log(`[GraphRegistry] buildAgentState() — wsChannel="${ wsChannel }", threadId="${ id }"`);

  const mode = await SullaSettingsModel.get('modelMode', 'remote');
  const llmModel = mode === 'remote'
    ? await SullaSettingsModel.get('remoteModel', '')
    : await SullaSettingsModel.get('sullaModel', '');
  const llmLocal = mode === 'local';

  const agentConfig = await loadAgentConfig(wsChannel);
  console.log(`[GraphRegistry] buildAgentState() — agent config for "${ wsChannel }": name="${ agentConfig?.name || '(none)' }", hasPrompt=${ !!agentConfig?.prompt }, type="${ agentConfig?.type || '(none)' }"`);

  return {
    messages: [],
    metadata: {
      action:    'direct_answer',
      threadId:  id,
      wsChannel,

      cycleComplete:  false,
      waitingForUser: false,
      isSubAgent:     false,
      subAgentDepth:  0,

      llmModel,
      llmLocal,
      options:              { abort: undefined },
      currentNodeId:        'input_handler',
      consecutiveSameNode:  0,
      iterations:           0,
      revisionCount:        0,
      maxIterationsReached: false,
      memory:               {
        knowledgeBaseContext: '',
        chatSummariesContext: '',
      },
      subGraph: {
        state:    'completed',
        name:     'hierarchical',
        prompt:   '',
        response: '',
      },
      finalSummary:         '',
      finalState:           'running',
      n8nLiveEventsEnabled: false,
      returnTo:             null,

      conversationId: id,

      isTrustedUser:      graphOpts?.isTrustedUser ?? 'trusted',
      userVisibleBrowser: graphOpts?.userVisibleBrowser ?? true,

      agent:          agentConfig,
      agentLoopCount: 0,
    },
  };
}

/**
 * Load agent configuration from ~/sulla/agents/{agentId}/
 * Reads config.yaml for config and compiles all .md files into a single prompt.
 * Returns undefined if agent directory doesn't exist.
 */
async function loadAgentConfig(agentId: string): Promise<AgentGraphState['metadata']['agent']> {
  console.log(`[GraphRegistry] loadAgentConfig() — agentId="${ agentId }"`);
  if (!agentId) {
    console.log(`[GraphRegistry] loadAgentConfig() — empty agentId, returning undefined`);
    return undefined;
  }

  const agentDir = findAgentDir(agentId);
  if (!agentDir) {
    console.log(`[GraphRegistry] loadAgentConfig() — agent dir not found for: ${ agentId }`);
    return undefined;
  }

  const yamlPath = path.join(agentDir, 'config.yaml');
  if (!fs.existsSync(yamlPath)) {
    console.log(`[GraphRegistry] loadAgentConfig() — config.yaml not found: ${ yamlPath }`);
    return undefined;
  }
  console.log(`[GraphRegistry] loadAgentConfig() — found agent at ${ agentDir }`);

  try {
    const yaml = await import('yaml');
    const parsed = yaml.parse(fs.readFileSync(yamlPath, 'utf-8'));

    // Compile all .md files into a single prompt (no variable substitution)
    const entries = fs.readdirSync(agentDir, { withFileTypes: true });
    const mdFiles = entries
      .filter(e => e.isFile() && e.name.endsWith('.md') && e.name !== 'environment.md')
      .sort((a, b) => {
        // soul.md first, then alphabetical
        const order = (name: string) => name === 'soul.md' ? 0 : 1;
        return order(a.name) - order(b.name) || a.name.localeCompare(b.name);
      });

    const sections: string[] = [];
    for (const file of mdFiles) {
      const content = fs.readFileSync(path.join(agentDir, file.name), 'utf-8').trim();
      if (content) {
        sections.push(content);
      }
    }

    return {
      name:         parsed.name || agentId,
      description:  parsed.description || '',
      type:         parsed.type || 'worker',
      skills:       parsed.skills || [],
      tools:        parsed.tools || [],
      integrations: parsed.integrations || [],
      prompt:       sections.length > 0 ? sections.join('\n\n') : undefined,
      excludeSoul:  parsed.excludeSoul === true,
      model:        typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : undefined,
      provider:     typeof parsed.provider === 'string' && parsed.provider.trim() ? parsed.provider.trim() : undefined,
    };
  } catch (err) {
    console.error(`[GraphRegistry] Failed to load agent config for ${ agentId }:`, err);
    return undefined;
  }
}

/**
 * Cap the conversation context handed to a subconscious agent: keep only the
 * most recent `windowSize` messages and truncate oversized text/tool_result
 * blocks. Recall/observation agents analyze the RECENT conversation and then
 * work through their search tools — handing them the whole thread (with
 * multi-KB tool dumps) just inflates every one of their LLM round-trips.
 * This is an INPUT diet, not a time limit: the agents still run for as long
 * as their job takes. Parent message objects are never mutated — truncated
 * messages are shallow clones.
 */
function windowedContext(messages: any[], windowSize: number, maxBlockChars: number): any[] {
  const marker = '\n…[earlier content truncated for subconscious context — use your search tools for full detail]';

  return messages.slice(-windowSize).map((m) => {
    const c = m?.content;

    if (typeof c === 'string') {
      return c.length > maxBlockChars ? { ...m, content: c.slice(0, maxBlockChars) + marker } : m;
    }
    if (Array.isArray(c)) {
      let changed = false;
      const blocks = c.map((b) => {
        if (b?.type === 'tool_result') {
          const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');

          if (text.length > maxBlockChars) {
            changed = true;

            return { ...b, content: text.slice(0, maxBlockChars) + marker };
          }
        }
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.length > maxBlockChars) {
          changed = true;

          return { ...b, text: b.text.slice(0, maxBlockChars) + marker };
        }

        return b;
      });

      return changed ? { ...m, content: blocks } : m;
    }

    return m;
  });
}

async function buildSubconsciousState(opts: {
  systemPrompt:          string;
  tools:                 string[];
  userMessage:           string;
  messages?:             any[];
  /** Keep only the last N conversation messages as agent context (see windowedContext) */
  contextWindow?:        number;
  /** Per-block truncation size used with contextWindow; default 4000 chars */
  maxContextBlockChars?: number;
  maxIterations?:        number;
  temperature?:          number;
  format?:               'json';
  maxTokens?:            number;
  responseHandler?:      (response: string, state: BaseThreadState) => void;
  parentAbortSignal?:    any;
  /** Label for logging — identifies which subconscious agent this is */
  agentLabel?:           string;
  /** Parent conversation ID for log tracing */
  parentConversationId?: string;
  /** Parent's WebSocket channel — subconscious agents push thinking messages here */
  parentWsChannel?:      string;
  /** When invoked inside a workflow run, these route the subagent's
      BaseNode.wsChatMessage emits into the workflow's live stream so the
      user can see subconscious work progressing (otherwise a long memory-
      recall looks like a total stall on the canvas). */
  workflowNodeId?:       string;
  workflowParentChannel?: string;
}): Promise<BaseThreadState> {
  const threadId = `subconscious_${ Date.now() }_${ ++threadCounter }`;

  const mode = await SullaSettingsModel.get('modelMode', 'remote');
  const llmModel = mode === 'remote'
    ? await SullaSettingsModel.get('remoteModel', '')
    : await SullaSettingsModel.get('sullaModel', '');
  const llmLocal = mode === 'local';

  // Pre-resolve tool schemas for the LLM
  const llmTools = await Promise.all(
    opts.tools.map(name => toolRegistry.convertToolToLLM(name)),
  );

  // Build messages: use provided messages array + append user message, or just user message.
  // When contextWindow is set, the agent gets the conversation TAIL with long
  // blocks truncated instead of the full thread — see windowedContext().
  const context: any[] = opts.messages
    ? (opts.contextWindow ? windowedContext(opts.messages, opts.contextWindow, opts.maxContextBlockChars ?? 4_000) : [...opts.messages])
    : [];
  const messages: any[] = [...context, { role: 'user', content: opts.userMessage, metadata: { source: 'subconscious' } }];

  return {
    messages,
    // llmTools must be on the top-level state object — normalizedChat()
    // reads (state as any).llmTools, NOT state.metadata.llmTools
    llmTools,
    metadata: {
      action:               'use_tools',
      threadId,
      conversationId:       threadId,
      parentConversationId: opts.parentConversationId,
      parentWsChannel:      opts.parentWsChannel,
      agentLabel:           opts.agentLabel,
      wsChannel:            opts.agentLabel ? `subconscious:${ opts.agentLabel }` : 'subconscious',
      cycleComplete:        false,
      waitingForUser:       false,
      isSubAgent:           true,
      subAgentDepth:        0,
      llmModel,
      llmLocal,
      options:              { abort: opts.parentAbortSignal },
      currentNodeId:        'subconscious',
      consecutiveSameNode:  0,
      iterations:           0,
      revisionCount:        0,
      maxIterationsReached: false,
      memory:               { knowledgeBaseContext: '', chatSummariesContext: '' },
      subGraph:             { state: 'completed', name: '', prompt: '', response: '' },
      finalSummary:         '',
      finalState:           'running',
      n8nLiveEventsEnabled: false,
      returnTo:             null,

      // Subconscious-specific fields
      systemPrompt:     `${ SUBCONSCIOUS_ENVIRONMENT_ANCHOR }\n\n${ opts.systemPrompt }`,
      allowedToolNames: opts.tools,
      temperature:      opts.temperature,
      format:           opts.format,
      maxTokens:        opts.maxTokens,
      responseHandler:  opts.responseHandler,

      // Workflow routing — when set, BaseNode.wsChatMessage will emit
      // `node_thinking` events into the workflow's live stream so the
      // user sees subconscious progress instead of a dead canvas during
      // long recall/observation phases. The `agentLabel` prefix is what
      // the frontend uses to attribute the thought to the subconscious
      // rather than the orchestrator node itself.
      workflowNodeId:        opts.workflowNodeId,
      workflowParentChannel: opts.workflowParentChannel,
      workflowThinkingLabel: opts.agentLabel,
    },
  } as any;
}
