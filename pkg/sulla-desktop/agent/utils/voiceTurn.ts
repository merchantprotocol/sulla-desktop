// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Routing for spoken turns from Sulla Mobile (voice mode and push-to-talk).
 *
 * A spoken turn always runs on the built-in voice agent with that agent's own
 * fast model. The phone's agent/model picker only applies to typed turns:
 * applying it to voice put the reply on the user's heavy chat model and also
 * paid a live provider/model catalog check before the turn could start.
 */

export const VOICE_AGENT_ID = 'conversationalist';

/** Same shape the mobile trace ids use (`vt_<base36>_<base36>`). */
const VOICE_TURN_ID_RE = /^vt_[a-z0-9_]{3,80}$/i;

/** A content-free trace id, or '' when the value isn't one. */
export function cleanVoiceTurnId(value: unknown): string {
  return typeof value === 'string' && VOICE_TURN_ID_RE.test(value) ? value : '';
}

export interface VoiceTurnRoute {
  agentId:      string;
  voiceTurnId?: string;
}

/**
 * The selection a relay chat frame runs with when it was spoken, or null for
 * a typed turn (which keeps validating the phone's picker as before).
 */
export function voiceTurnRoute(frame: { voiceMode?: unknown; voiceTurnId?: unknown } | null | undefined): VoiceTurnRoute | null {
  if (frame?.voiceMode !== true) return null;
  const voiceTurnId = cleanVoiceTurnId(frame.voiceTurnId);

  return voiceTurnId ? { agentId: VOICE_AGENT_ID, voiceTurnId } : { agentId: VOICE_AGENT_ID };
}

/** One content-free `[VoiceTrace]` line, same format as BaseNode's spans. */
export function logVoiceSpan(turnId: unknown, stage: string, data: { durationMs?: number; size?: number; reason?: string } = {}): void {
  const id = cleanVoiceTurnId(turnId);
  if (!id) return;
  console.log(`[VoiceTrace] ${ JSON.stringify({ turnId: id, stage, ts: new Date().toISOString(), ...data }) }`);
}
