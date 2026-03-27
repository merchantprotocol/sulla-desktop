/**
 * Virtual audio device detection — extracted from SecretaryModeController
 * for testability and reuse.
 *
 * Detects virtual audio input devices (BlackHole, ZoomAudioDevice, etc.)
 * that can capture system/speaker audio on macOS.
 */

/** Patterns that identify virtual audio loopback devices */
export const VIRTUAL_DEVICE_PATTERNS: RegExp[] = [
  /zoom\s*audio/i,
  /blackhole/i,
  /loopback/i,
  /soundflower/i,
  /virtual.*audio/i,
  /vb-cable/i,
  /sulla.*audio/i,
];

/**
 * Find a virtual audio input device from a list of MediaDeviceInfo objects.
 * Returns the first matching device, or null if none found.
 */
export function findVirtualAudioDevice(
  devices: MediaDeviceInfo[],
  patterns: RegExp[] = VIRTUAL_DEVICE_PATTERNS,
): MediaDeviceInfo | null {
  const audioInputs = devices.filter(d => d.kind === 'audioinput');
  return audioInputs.find(d => patterns.some(p => p.test(d.label))) ?? null;
}

/**
 * Check whether a given device label matches any virtual audio device pattern.
 */
export function isVirtualAudioDevice(
  label: string,
  patterns: RegExp[] = VIRTUAL_DEVICE_PATTERNS,
): boolean {
  return patterns.some(p => p.test(label));
}
