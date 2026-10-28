// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Centralized configuration — all environment-driven URLs in one place.
 */

export const GHOST_AGENT_URL =
  process.env.GHOST_AGENT_URL || 'https://app.dataripple.com';

export const GATEWAY_URL =
  process.env.GATEWAY_URL || 'https://gateway.dataripple.com';

export const IS_LOCAL = new URL(GHOST_AGENT_URL).hostname === 'localhost' ||
  new URL(GATEWAY_URL).hostname === 'localhost';
