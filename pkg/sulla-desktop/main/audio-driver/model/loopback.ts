// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Model — loopback driver detection and management.
 * Thin wrapper around the platform provider with caching.
 */

import * as platform from '../platform';

let cachedDevice: any = null;

export async function detect() {
  const result = await platform.loopback.detect();
  cachedDevice = result.found ? result : null;
  return result;
}

export function getDevice() {
  return cachedDevice;
}

export function getUID(): string | null {
  return cachedDevice?.uid || null;
}

export function isAvailable(): boolean {
  return cachedDevice?.found === true;
}

export function isCustomDriver(): boolean {
  return cachedDevice?.driver === 'custom';
}
