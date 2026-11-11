// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { callingYourTeamSection } from '../prompts/callingYourTeam';
import { MAX_SUBAGENT_DEPTH } from '../tools/agents/jobRegistry';
import type { UseCaseSuggestionQuery } from './UseCaseSuggestionQueryClient';
import type { AgentDefinition } from '../database/models/AgentDefinitionModel';
import type { AgentDirectoryCard } from './AgentDirectoryService';

export const TEAM_FIT_MAX = 2;
export const TEAM_DIRECTORY_MAX_CHARS = 3500;
const FIT_MARK = '**fits right now** · ';
const CALLING_YOUR_TEAM_HEADING = /^#{1,6}\s*Calling your team\b/im;

export function promptHasCallingYourTeam(agent: AgentDefinition): boolean {
  return [agent.system_prompt, agent.prompt_content, ...Object.values(agent.prompt_files ?? {})]
    .some(text => CALLING_YOUR_TEAM_HEADING.test(String(text ?? '')));
}

export interface TeamRecallOptions { agentSlug: string; text: string; maxChars?: number; depth?: number }

export function depthBudgetLine(depth: number): string {
  const remaining = Math.max(MAX_SUBAGENT_DEPTH - depth, 0);
  return remaining > 0
    ? `You are at sub-agent depth ${ depth } of ${ MAX_SUBAGENT_DEPTH }; you can launch ${ remaining } more level${ remaining === 1 ? '' : 's' }.`
    : `You are at sub-agent depth ${ depth } of ${ MAX_SUBAGENT_DEPTH }; you cannot launch sub-agents (max depth reached).`;
}

/** Team recall filters semantic suggestions through the lead's explicit can_call policy. */
export class AgentTeamRecallService {
  constructor(
    private readonly suggestions: UseCaseSuggestionQuery,
    private readonly findAgent: (slug: string) => Promise<AgentDefinition | null>,
    private readonly listDirectory: (slugs: string[]) => Promise<AgentDirectoryCard[]>,
    private readonly formatCard: (card: AgentDirectoryCard) => string,
  ) {}

  async buildContext(opts: TeamRecallOptions): Promise<string> {
    const slug = opts.agentSlug.trim();
    if (!slug) return '';
    const self = await this.findAgent(slug);
    if (!self || self.can_call.length === 0) return '';
    const canCall = new Set(self.can_call);
    const directoryCards = (await this.listDirectory(self.can_call))
      .filter(card => card.slug !== slug && (canCall.has('*') || canCall.has(card.slug)));
    if (directoryCards.length === 0) return '';

    // Query the main-process index; retain the author's allowlist and order as policy/tie-breaks.
    const allowlist = new Set(directoryCards.map(card => card.slug));
    const suggestions = await this.suggestions.query(opts.text, { types: ['agent'], allowedSlugs: [...allowlist], limit: 50 });
    const publishedSuggestions = suggestions.filter(item => allowlist.has(item.slug));
    const publishedSlugs = new Set(publishedSuggestions.map(item => item.slug));
    const cards = directoryCards.filter(card => publishedSlugs.has(card.slug));
    if (cards.length === 0) return '';
    const scoreBySlug = new Map(publishedSuggestions.map(item => [item.slug, item.score]));
    const order = new Map(self.can_call.map((callee, index) => [callee, index]));
    const ranked = cards.map(card => ({ card, score: scoreBySlug.get(card.slug) ?? 0 }))
      .sort((a, b) => b.score - a.score || (order.get(a.card.slug) ?? 0) - (order.get(b.card.slug) ?? 0));
    const top = ranked[0]?.score ?? 0;
    const fits = new Set(ranked.filter(entry => entry.score > 0 && entry.score >= top * 0.5).slice(0, TEAM_FIT_MAX).map(entry => entry.card.slug));

    const header = [
      '## Team directory',
      ...(typeof opts.depth === 'number' ? [depthBudgetLine(opts.depth)] : []),
      fits.size
        ? 'Agents you can call, ranked for the current situation. “fits right now” is a semantic suggestion, not an order; you decide.'
        : 'Agents you can call. Nothing in the current situation clearly points to one of them.',
      'Call: `sulla meta/spawn_agent \'{"tasks":[{"agentId":"<slug>","prompt":"<full brief>"}],"async":true}\'`; every child runs hidden (never open visible tabs). Full cards: `sulla agents/directory`.',
    ].join('\n');

    const maxChars = opts.maxChars ?? TEAM_DIRECTORY_MAX_CHARS;
    const lines: string[] = [];
    let size = header.length;
    for (const [index, { card }] of ranked.entries()) {
      const full = this.formatCard(card);
      const line = fits.has(card.slug) ? full.replace(/^- /, `- ${ FIT_MARK }`) : full.split('\n')[0];
      if (size + line.length + 1 > maxChars) { lines.push(`- …${ ranked.length - index } more: \`sulla agents/directory\``); break; }
      lines.push(line); size += line.length + 1;
    }
    const directory = [header, ...lines].join('\n');
    return promptHasCallingYourTeam(self) ? directory : `${ callingYourTeamSection }\n\n${ directory }`;
  }
}

/** Compatibility entry point used by SubconsciousMiddleware. */
export async function buildTeamRecallContext(opts: TeamRecallOptions, suggestions: UseCaseSuggestionQuery): Promise<string> {
  const [{ agentDefinitionService }, { listAgentDirectory, formatCardLine }] = await Promise.all([
    import('./AgentDefinitionService'), import('./AgentDirectoryService'),
  ]);
  return new AgentTeamRecallService(
    suggestions,
    slug => agentDefinitionService.findBySlug(slug),
    slugs => listAgentDirectory({ slugs }),
    formatCardLine,
  ).buildContext(opts);
}
