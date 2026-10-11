/**
 * Agent directory — compact cards for every agent in agent_definitions, so
 * any agent can see the team and call the right specialist next.
 *
 * Everything is built from the table on each call; there is no hard-coded
 * roster. Cards come from the directory columns (when_to_call, send, ...),
 * falling back to the description when an agent has no card yet.
 *
 * Interfaces for the subconscious layer:
 *   - buildAgentTeamBlock(opts)   → "<agent_team>" prompt block
 *   - suggestAgentsForText(text)  → ranked cards for the current situation
 */

import { agentDefinitionService } from './AgentDefinitionService';

import type { AgentCostTier, AgentDefinition } from '../database/models/AgentDefinitionModel';

export interface AgentDirectoryCard {
  slug:          string;
  name:          string;
  description:   string;
  whenToCall:    string;
  whenNotToCall: string;
  send:          string;
  returns:       string;
  costTier:      AgentCostTier | null;
  canCall:       string[];
  provider:      string | null;
  model:         string | null;
  builtin:       boolean;
  enabled:       boolean;
  status:        string;
}

export interface AgentDirectoryQuery {
  /** Free-text search over slug, name, description and card fields. */
  query?:           string;
  /** Include disabled and archived agents (default false). */
  includeInactive?: boolean;
  /** Restrict to these slugs (e.g. a lead agent's can_call list). */
  slugs?:           string[];
  limit?:           number;
}

export interface AgentTeamBlockOptions {
  /** The agent the block is for. It is left out, and its can_call list (if any) scopes the team. */
  forAgentSlug?: string;
  /** Rank by relevance to this text (e.g. the current user message). */
  query?:        string;
  limit?:        number;
  /** Hard cap on the block size in characters (default 4000). */
  maxChars?:     number;
}

const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'please', 'that', 'the', 'this', 'to', 'we', 'what', 'with', 'you']);

export function isActiveAgent(agent: AgentDefinition): boolean {
  return agent.enabled && agent.status !== 'archive';
}

export function toDirectoryCard(agent: AgentDefinition): AgentDirectoryCard {
  return {
    slug:          agent.slug,
    name:          agent.name,
    description:   agent.description,
    whenToCall:    agent.when_to_call || agent.description,
    whenNotToCall: agent.when_not_to_call,
    send:          agent.send,
    returns:       agent.returns,
    costTier:      agent.cost_tier,
    canCall:       agent.can_call,
    provider:      agent.provider,
    model:         agent.model,
    builtin:       agent.is_builtin,
    enabled:       agent.enabled,
    status:        agent.status,
  };
}

function tokenize(text: string): string[] {
  return String(text ?? '').toLowerCase().split(/[^a-z0-9]+/)
    .filter(token => token.length > 1 && !STOP_WORDS.has(token))
    .map(token => (token.length > 3 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token));
}

/**
 * Keyword relevance of a card to free text. when_to_call and the name weigh
 * most; when_not_to_call matches count against the card.
 */
export function scoreCard(card: AgentDirectoryCard, text: string): number {
  const terms = new Set(tokenize(text));
  if (terms.size === 0) return 0;
  const weigh = (field: string, weight: number) => tokenize(field).reduce((sum, token) => sum + (terms.has(token) ? weight : 0), 0);
  return weigh(`${ card.slug } ${ card.name }`, 3) +
    weigh(card.whenToCall, 2) +
    weigh(card.description, 1) +
    weigh(card.returns, 0.5) -
    weigh(card.whenNotToCall, 1);
}

export async function listAgentDirectory(opts: AgentDirectoryQuery = {}): Promise<AgentDirectoryCard[]> {
  const agents = await agentDefinitionService.list();
  const slugFilter = opts.slugs?.length ? new Set(opts.slugs) : null;
  let cards = agents
    .filter(agent => opts.includeInactive || isActiveAgent(agent))
    .filter(agent => !slugFilter || slugFilter.has(agent.slug))
    .map(toDirectoryCard);

  const query = opts.query?.trim();
  if (query) {
    cards = cards
      .map(card => ({ card, score: scoreCard(card, query) }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.card.slug.localeCompare(b.card.slug))
      .map(entry => entry.card);
  }

  return opts.limit && opts.limit > 0 ? cards.slice(0, opts.limit) : cards;
}

/** Ranked cards that fit the current situation. Empty when nothing matches. */
export function suggestAgentsForText(text: string, limit = 3): Promise<AgentDirectoryCard[]> {
  return listAgentDirectory({ query: text, limit });
}

/** One compact line per agent, as used in the team block. */
export function formatCardLine(card: AgentDirectoryCard): string {
  const meta = [card.costTier ? `${ card.costTier } cost` : '', card.model ?? ''].filter(Boolean).join(', ');
  const parts = [`- **${ card.slug }** (${ card.name }${ meta ? `; ${ meta }` : '' }): ${ card.whenToCall }`];
  if (card.whenNotToCall) parts.push(`  Not for: ${ card.whenNotToCall }`);
  if (card.send) parts.push(`  Send: ${ card.send }`);
  if (card.returns) parts.push(`  Returns: ${ card.returns }`);
  return parts.join('\n');
}

/**
 * Compact "Your team" block built from agent_definitions, ready to inject
 * into an agent prompt. Returns '' when there is no one to call.
 */
export async function buildAgentTeamBlock(opts: AgentTeamBlockOptions = {}): Promise<string> {
  const maxChars = opts.maxChars ?? 4000;
  const self = opts.forAgentSlug ? await agentDefinitionService.findBySlug(opts.forAgentSlug) : null;
  const scoped = self?.can_call.length ? self.can_call : undefined;

  let cards = await listAgentDirectory({ slugs: scoped });
  cards = cards.filter(card => card.slug !== opts.forAgentSlug);
  if (opts.query?.trim()) {
    const ranked = cards.map(card => ({ card, score: scoreCard(card, opts.query!) }));
    cards = ranked.sort((a, b) => b.score - a.score || a.card.slug.localeCompare(b.card.slug)).map(entry => entry.card);
  }
  if (opts.limit && opts.limit > 0) cards = cards.slice(0, opts.limit);
  if (cards.length === 0) return '';

  const header = [
    '<agent_team>',
    'Your team: specialists you can call. Pick the one whose card fits, send what it asks for, then decide the next step from what it returns.',
    'Call: sulla meta/spawn_agent \'{"tasks":[{"agentId":"<slug>","prompt":"<self-contained brief>"}]}\' (async; the result wakes you). Full cards: sulla agents/directory.',
  ].join('\n');
  const footer = '</agent_team>';

  const lines: string[] = [];
  let size = header.length + footer.length + 2;
  for (const card of cards) {
    const line = formatCardLine(card);
    if (size + line.length + 1 > maxChars) {
      lines.push(`- …${ cards.length - lines.length } more: sulla agents/directory`);
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }

  return [header, ...lines, footer].join('\n');
}
