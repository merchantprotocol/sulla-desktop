// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
export const MIN_COMMAND_TIMEOUT_MS = 1_000;
export const MAX_COMMAND_TIMEOUT_MS = 4 * 60 * 60_000; // long VM builds legitimately run for hours

/** Clamp a millisecond timeout into [1 s, 4 h]. */
export function clampTimeoutMs(ms: number): number {
  return Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(MIN_COMMAND_TIMEOUT_MS, ms));
}

/**
 * Normalise a caller-supplied `timeout` field that is documented as milliseconds.
 * Agents often pass seconds (e.g. 60), so any positive value under 1000 is read
 * as seconds. Non-numeric, NaN, or non-positive values fall back to `fallbackMs`.
 * The result is always clamped to [1 s, 4 h].
 */
export function normalizeTimeoutMs(raw: unknown, fallbackMs: number = DEFAULT_COMMAND_TIMEOUT_MS): number {
  if (raw === undefined || raw === null || raw === '') return clampTimeoutMs(fallbackMs);
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return clampTimeoutMs(fallbackMs);
  return clampTimeoutMs(n < MIN_COMMAND_TIMEOUT_MS ? n * 1000 : n);
}
