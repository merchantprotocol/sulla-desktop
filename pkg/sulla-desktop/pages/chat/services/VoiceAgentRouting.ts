// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Selects the fast built-in voice agent without overriding an explicit chat selection. */
export class VoiceAgentRouting {
  constructor(private readonly voiceAgentId = 'conversationalist') {}

  resolve(inputSource: 'voice' | undefined, selectedAgentId?: string | null): string | undefined {
    if (selectedAgentId) return selectedAgentId;
    return inputSource === 'voice' ? this.voiceAgentId : undefined;
  }
}
