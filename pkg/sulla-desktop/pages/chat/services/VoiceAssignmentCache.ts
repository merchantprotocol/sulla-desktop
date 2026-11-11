// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { VoiceIdentityMetadata } from './VoiceTranscriptTagger';

interface TimedVoiceAssignment extends VoiceIdentityMetadata { assignedAt: number; }

/** Bounded, non-blocking handoff from background voice scoring to transcript commit. */
export class VoiceAssignmentCache {
  private readonly assignments = new Map<string, TimedVoiceAssignment>();
  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = 60_000, private readonly maxEntries = 50) {}
  put(turnId: string, assignment: VoiceIdentityMetadata): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, value] of this.assignments) if (value.assignedAt < cutoff) this.assignments.delete(id);
    this.assignments.set(turnId, { ...assignment, assignedAt: this.now() });
    while (this.assignments.size > this.maxEntries) this.assignments.delete(this.assignments.keys().next().value!);
  }
  take(turnId: string): VoiceIdentityMetadata | undefined {
    const value = this.assignments.get(turnId);
    this.assignments.delete(turnId);
    if (!value || this.now() - value.assignedAt > this.ttlMs) return undefined;
    const { voiceId, voiceLabel, isOwner, score } = value;
    return { voiceId, voiceLabel, isOwner, score };
  }
}
