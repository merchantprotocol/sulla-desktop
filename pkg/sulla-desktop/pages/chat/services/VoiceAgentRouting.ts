// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Voice turns always go to the fast built-in voice agent (Jonathon, 2026-11-10: option A).
 * The Conversationalist answers quickly, hands real work to workers, and already stays
 * silent on overheard speech, so it doubles as the "is this for Sulla?" check.
 * Typed chat keeps the chat's selected agent.
 */
export class VoiceAgentRouting {
  constructor(private readonly voiceAgentId = 'conversationalist') {}

  resolve(inputSource: 'voice' | undefined, selectedAgentId?: string | null): string | undefined {
    if (inputSource === 'voice') return this.voiceAgentId;
    return selectedAgentId || undefined;
  }
}
