/**
 * Per-turn team recall for lead agents — the subconscious "which agents fit
 * right now" step. Pure keyword ranking over the agent directory: no LLM call,
 * one table read, bounded size. It only suggests; the lead agent decides.
 *
 * A lead agent is one whose directory card has a non-empty can_call. Its turn
 * context gets a "Team directory" of the agents it may call, ranked by the
 * current situation (latest user message or sub-agent result), plus the shared
 * "Calling your team" section when the agent's own prompt doesn't carry it. Cards that match strongly are marked
 * "fits right now"; when nothing matches strongly, nothing is marked.
 */

import { agentDefinitionService } from './AgentDefinitionService';
import { formatCardLine, listAgentDirectory, scoreCard } from './AgentDirectoryService';
import { callingYourTeamSection } from '../prompts/callingYourTeam';

import type { AgentDefinition } from '../database/models/AgentDefinitionModel';

/** A card needs at least this keyword score to be called a fit at all. */
export const TEAM_FIT_MIN_SCORE = 5;
/** ...and at least this share of the best card's score. */
export const TEAM_FIT_RELATIVE = 0.5;
export const TEAM_FIT_MAX = 2;
/** Cap on the Team directory part of the block (the section is fixed size). */
export const TEAM_DIRECTORY_MAX_CHARS = 3500;

const FIT_MARK = '**fits right now** · ';
const CALLING_YOUR_TEAM_HEADING = /^#{1,6}\s*Calling your team\b/im;

/** True when the agent's stored prompt already includes the shared section. */
export function promptHasCallingYourTeam(agent: AgentDefinition): boolean {
  return [agent.system_prompt, agent.prompt_content, ...Object.values(agent.prompt_files ?? {})]
    .some(text => CALLING_YOUR_TEAM_HEADING.test(String(text ?? '')));
}

export interface TeamRecallOptions {
  /** The lead agent's slug (its agent identity). */
  agentSlug: string;
  /** Situation text to rank by. */
  text:      string;
  maxChars?: number;
}

/**
 * The context block body for a lead agent, or '' when the agent calls no one
 * (or no one it may call is active).
 */
export async function buildTeamRecallContext(opts: TeamRecallOptions): Promise<string> {
  const slug = opts.agentSlug.trim();
  if (!slug) return '';
  const self = await agentDefinitionService.findBySlug(slug);
  if (!self || self.can_call.length === 0) return '';

  const cards = (await listAgentDirectory({ slugs: self.can_call })).filter(card => card.slug !== slug);
  if (cards.length === 0) return '';

  // Keep the lead's own can_call order as the tie-break: it is the author's
  // preference order when nothing in the situation points anywhere.
  const order = new Map(self.can_call.map((callee, index) => [callee, index]));
  const ranked = cards
    .map(card => ({ card, score: opts.text.trim() ? scoreCard(card, opts.text) : 0 }))
    .sort((a, b) => b.score - a.score || (order.get(a.card.slug) ?? 0) - (order.get(b.card.slug) ?? 0));
  const top = ranked[0]?.score ?? 0;
  const fits = new Set(ranked
    .filter(entry => entry.score >= TEAM_FIT_MIN_SCORE && entry.score >= top * TEAM_FIT_RELATIVE)
    .slice(0, TEAM_FIT_MAX)
    .map(entry => entry.card.slug));

  const header = [
    '## Team directory',
    fits.size
      ? 'Agents you can call, ranked for the current situation. "fits right now" is a keyword suggestion, not an order; you decide.'
      : 'Agents you can call. Nothing in the current situation clearly points to one of them.',
    'Call: `sulla meta/spawn_agent \'{"tasks":[{"agentId":"<slug>","prompt":"<full brief>"}],"async":true}\'`; add `"visibility":"tab"` to a task for leads that run their own team. Full cards: `sulla agents/directory`.',
  ].join('\n');

  const maxChars = opts.maxChars ?? TEAM_DIRECTORY_MAX_CHARS;
  const lines: string[] = [];
  let size = header.length;
  for (const [index, { card }] of ranked.entries()) {
    // Full card for the fits; one line for everyone else (sulla agents/directory has the rest).
    const full = formatCardLine(card);
    const line = fits.has(card.slug) ? full.replace(/^- /, `- ${ FIT_MARK }`) : full.split('\n')[0];
    if (size + line.length + 1 > maxChars) {
      lines.push(`- …${ ranked.length - index } more: \`sulla agents/directory\``);
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }

  const directory = [header, ...lines].join('\n');
  return promptHasCallingYourTeam(self) ? directory : `${ callingYourTeamSection }\n\n${ directory }`;
}
