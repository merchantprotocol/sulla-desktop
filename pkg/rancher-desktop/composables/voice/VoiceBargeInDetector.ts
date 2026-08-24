export const DEFAULT_BARGE_IN_GRACE_MS = 400;

export interface VoiceBargeInDetector {
  update(speaking: boolean, playbackActive: boolean): boolean;
  reset(): void;
}

export interface VoiceBargeInDetectorOptions {
  graceMs?: number;
  now?:     () => number;
}

/**
 * Distinguishes deliberate speech from short VAD spikes while Sulla is talking.
 * Returns true once per sustained-speech interruption.
 */
export function createVoiceBargeInDetector(
  options: VoiceBargeInDetectorOptions = {},
): VoiceBargeInDetector {
  const graceMs = options.graceMs ?? DEFAULT_BARGE_IN_GRACE_MS;
  const now = options.now ?? Date.now;
  let speechStartedAt: number | null = null;

  return {
    update(speaking: boolean, playbackActive: boolean): boolean {
      if (!speaking || !playbackActive) {
        speechStartedAt = null;
        return false;
      }

      const currentTime = now();
      if (speechStartedAt === null) {
        speechStartedAt = currentTime;
        return false;
      }

      if (currentTime - speechStartedAt < graceMs) return false;

      speechStartedAt = null;
      return true;
    },

    reset(): void {
      speechStartedAt = null;
    },
  };
}
