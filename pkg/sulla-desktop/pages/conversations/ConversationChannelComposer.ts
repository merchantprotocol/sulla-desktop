// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface ConversationChannelTarget {
  serverId: string;
  channelId: string;
}

export interface ConversationChannelSubmission extends ConversationChannelTarget {
  body: string;
}

export class ConversationChannelComposer {
  private readonly drafts = new Map<string, string>();

  draft(target: ConversationChannelTarget): string {
    return this.drafts.get(this.key(target)) ?? '';
  }

  updateDraft(target: ConversationChannelTarget, body: string): void {
    this.drafts.set(this.key(target), body);
  }

  capture(target: ConversationChannelTarget, body: string): ConversationChannelSubmission | undefined {
    const trimmedBody = body.trim();
    if (!trimmedBody) return undefined;
    return { ...target, body: trimmedBody };
  }

  clearAfterSend(submission: ConversationChannelSubmission): void {
    const key = this.key(submission);
    if (this.drafts.get(key)?.trim() === submission.body) this.drafts.delete(key);
  }

  private key(target: ConversationChannelTarget): string {
    return JSON.stringify([target.serverId, target.channelId]);
  }
}
