// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Routing for spoken turns from Sulla Mobile (voice mode and push-to-talk).
 *
 * A spoken turn runs on whatever agent and model the chat has selected, the
 * same as a typed turn. Jonathon (2026-10-29) did not want voice locked to the
 * Conversationalist: its one-to-three-sentence cap withheld the context he
 * kept asking for. The Conversationalist stays available in the picker.
 */

export const VOICE_AGENT_ID = 'conversationalist';

/** Same shape the mobile trace ids use (`vt_<base36>_<base36>`). */
const VOICE_TURN_ID_RE = /^vt_[a-z0-9_]{3,80}$/i;

/** A content-free trace id, or '' when the value isn't one. */
export function cleanVoiceTurnId(value: unknown): string {
  return typeof value === 'string' && VOICE_TURN_ID_RE.test(value) ? value : '';
}

export interface VoiceTurnRoute {
  voiceTurnId?: string;
}

/**
 * Voice metadata for a spoken relay frame, or null for a typed turn. It never
 * picks the agent: both kinds of turn honour the phone's agent/model picker.
 */
export function voiceTurnRoute(frame: { voiceMode?: unknown; voiceTurnId?: unknown } | null | undefined): VoiceTurnRoute | null {
  if (frame?.voiceMode !== true) return null;
  const voiceTurnId = cleanVoiceTurnId(frame.voiceTurnId);

  return voiceTurnId ? { voiceTurnId } : {};
}

/** One content-free `[VoiceTrace]` line, same format as BaseNode's spans. */
export function logVoiceSpan(turnId: unknown, stage: string, data: { durationMs?: number; size?: number; reason?: string } = {}): void {
  const id = cleanVoiceTurnId(turnId);
  if (!id) return;
  console.log(`[VoiceTrace] ${ JSON.stringify({ turnId: id, stage, ts: new Date().toISOString(), ...data }) }`);
}
