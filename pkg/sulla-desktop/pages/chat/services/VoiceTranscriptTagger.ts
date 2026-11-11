// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface VoiceIdentityMetadata { voiceId: string; voiceLabel: string; isOwner: boolean; score: number; }

/** Formats agent-only voice labels and restores the untagged transcript for chat display. */
export class VoiceTranscriptTagger {
  prefix(identity: VoiceIdentityMetadata): string {
    const split = identity.voiceLabel.indexOf(' — ');
    const label = split < 0 ? identity.voiceLabel : identity.voiceLabel.slice(0, split);
    const name = split < 0 ? '' : identity.voiceLabel.slice(split + 3);
    return `[${label}${identity.isOwner ? ' (owner)' : ''}${name ? ` — ${name}` : ''}] `;
  }
  agentText(text: string, identity: VoiceIdentityMetadata): string { return `${this.prefix(identity)}${text}`; }
  userText(text: string, identity?: VoiceIdentityMetadata): string {
    const prefix = identity ? this.prefix(identity) : '';
    return prefix && text.startsWith(prefix) ? text.slice(prefix.length) : text;
  }
}
