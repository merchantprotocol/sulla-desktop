// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface CheckinEpisodeIdentityInput {
  id: string;
  text: string;
  source?: string;
  keys?: string[];
  conversationId?: string | null;
  conversation_id?: string | null;
  sentiment?: string | null;
}

/** Builds stable identities only for explicit, non-human status check-ins. */
export class CheckinIdentity {
  private static readonly agentJobPattern = /\b(agent-job-\d+-\d+)\b/gi;
  private static readonly spawnAgentThreadPattern = /\b(spawn-agent-[\w-]+)\b/gi;
  private static readonly pullRequestPattern = /\b(?:pull\s+request|pr|draft(?:\s+pr)?)\s*[:#-]?\s*#?\s*(\d+)\b/gi;
  private static readonly hashNumberPattern = /#(\d+)\b/g;
  private static readonly statusPattern =
    /\b(?:detailed chat trace|chat trace|check[ -]?in|status(?: update| report)?|progress(?: update| report)?|orchestrator wake[- ]?up|wake[- ]?up|sub[- ]agent result|agent result|worker report|heartbeat status|resume[ds]?|resuming|working on|currently working|next step|pushed|merged|blocked|completed|finished)\b/i;
  private static readonly roleStatusPattern =
    /\b(?:manager|coding[- ]manager|agent|worker|heartbeat|orchestrator)\b.{0,60}\b(?:turn|check[ -]?in|status|progress|report|result|update|wake[- ]?up)\b/i;
  private static readonly statusRolePattern =
    /\b(?:turn|check[ -]?in|status|progress|report|result|update|wake[- ]?up)\b.{0,60}\b(?:manager|coding[- ]manager|agent|worker|heartbeat|orchestrator)\b/i;
  private static readonly humanDecisionPattern =
    /\b(?:rule|decision|decided|approval|approved|correction|do\s+not|don['’]?t|prefer|must|never|always)\b|\b(?:jonathon|the user|user|human|owner)\b.{0,80}\b(?:said|asked|approved|decided|confirmed|corrected|requested|chose|wrote)\b|(?:^|\n)\s*>?\s*(?:jonathon|the user|user|human)\s*:\s*["“]?/i;
  private static readonly attributedQuotePattern =
    /\b(?:jonathon|the user|user|human|owner)\b.{0,80}\b(?:said|asked|quoted|wrote)\b.{0,30}["“]/i;

  static keyFor(episode: CheckinEpisodeIdentityInput): string | null {
    if (episode.source?.toLowerCase() === 'user') return null;
    if (episode.sentiment != null && episode.sentiment.toLowerCase() !== 'neutral') return null;
    if (this.recordsHumanDecision(episode.text)) return null;
    if (!this.isStatusCheckin(episode.text)) return null;

    const conversationId = this.conversationIdFor(episode);
    const identityText = [
      episode.id,
      episode.text,
      ...(episode.keys ?? []),
    ].join('\n');
    const jobIds = this.uniqueMatches(this.agentJobPattern, identityText);
    const explicitPullRequestNumbers = this.uniqueMatches(this.pullRequestPattern, identityText);
    const pullRequestNumbers = [...explicitPullRequestNumbers];
    for (const match of identityText.matchAll(this.hashNumberPattern)) {
      const number = match[1];
      if (number && !pullRequestNumbers.includes(number)) pullRequestNumbers.push(number);
    }

    if (jobIds.length > 1 || pullRequestNumbers.length > 1) return null;
    if (jobIds.length === 1) return this.identityKey('job', jobIds[0], conversationId);

    const spawnAgentThreads = this.uniqueMatches(this.spawnAgentThreadPattern, identityText);
    if (spawnAgentThreads.length > 1) return null;
    if (spawnAgentThreads.length === 1)
      return this.identityKey('thread', spawnAgentThreads[0], conversationId);

    const pullRequestNumber = pullRequestNumbers[0];
    if (pullRequestNumber) {
      if (!conversationId && explicitPullRequestNumbers.length === 0) return null;
      return this.identityKey('pr', pullRequestNumber, conversationId);
    }

    return null;
  }

  private static uniqueMatches(pattern: RegExp, text: string): string[] {
    return [...new Set([...text.matchAll(pattern)].map(match => match[1].toLowerCase()))];
  }

  private static conversationIdFor(episode: CheckinEpisodeIdentityInput): string | null {
    const conversationId = episode.conversationId ?? episode.conversation_id ?? null;
    return typeof conversationId === 'string' && conversationId.trim()
      ? conversationId.trim()
      : null;
  }

  private static identityKey(
    kind: 'job' | 'thread' | 'pr',
    identity: string,
    conversationId: string | null
  ): string {
    return conversationId
      ? `conv:${conversationId}|${kind}:${identity}`
      : `${kind}:${identity}`;
  }

  private static isStatusCheckin(text: string): boolean {
    return (
      this.statusPattern.test(text) ||
      this.roleStatusPattern.test(text) ||
      this.statusRolePattern.test(text)
    );
  }

  private static recordsHumanDecision(text: string): boolean {
    return (
      this.humanDecisionPattern.test(text) ||
      this.attributedQuotePattern.test(text)
    );
  }
}
