// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface CheckinEpisodeIdentityInput {
  id: string;
  text: string;
  source?: string;
  keys?: string[];
}

/** Builds stable identities only for explicit, non-human status check-ins. */
export class CheckinIdentity {
  private static readonly agentJobPattern = /\b(agent-job-\d+-\d+)\b/i;
  private static readonly threadPattern = /\b(thread_\w+)\b/i;
  private static readonly pullRequestPattern = /\b(?:pr|pull request|draft)\s*#\s*(\d+)\b/i;
  private static readonly statusPattern =
    /\b(?:detailed chat trace|chat trace|check[ -]?in|status(?: update| report)?|progress(?: update| report)?|orchestrator wake[- ]?up|wake[- ]?up|sub[- ]agent result|agent result|worker report|heartbeat status|resume[ds]?|resuming|working on|currently working|next step|pushed|merged|blocked|completed|finished)\b/i;
  private static readonly roleStatusPattern =
    /\b(?:manager|coding[- ]manager|agent|worker|heartbeat|orchestrator)\b.{0,60}\b(?:turn|check[ -]?in|status|progress|report|result|update|wake[- ]?up)\b/i;
  private static readonly statusRolePattern =
    /\b(?:turn|check[ -]?in|status|progress|report|result|update|wake[- ]?up)\b.{0,60}\b(?:manager|coding[- ]manager|agent|worker|heartbeat|orchestrator)\b/i;
  private static readonly humanDecisionPattern =
    /\b(?:rule|decision|approval|approved|correction)\b|\b(?:jonathon|the user|user|human|owner)\b.{0,80}\b(?:said|asked|approved|decided|confirmed|corrected|requested|chose|wrote)\b|(?:^|\n)\s*(?:jonathon|the user|user|human)\s*:\s*["“]?/i;
  private static readonly attributedQuotePattern =
    /\b(?:jonathon|the user|user|human|owner)\b.{0,80}\b(?:said|asked|quoted|wrote)\b.{0,30}["“]/i;

  static keyFor(episode: CheckinEpisodeIdentityInput): string | null {
    if (episode.source?.toLowerCase() === 'user') return null;
    if (this.recordsHumanDecision(episode.text)) return null;
    if (!this.isStatusCheckin(episode.text)) return null;

    const identityText = [episode.id, episode.text, ...(episode.keys ?? [])].join('\n');
    const jobId = identityText.match(this.agentJobPattern)?.[1];
    if (jobId) return `job:${jobId.toLowerCase()}`;

    const threadId = identityText.match(this.threadPattern)?.[1];
    if (threadId) return `thread:${threadId.toLowerCase()}`;

    const pullRequest = identityText.match(this.pullRequestPattern)?.[1];
    if (pullRequest && /\bepic\b/i.test(identityText)) return `pr:${pullRequest}`;

    return null;
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
