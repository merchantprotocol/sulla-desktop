// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Normalizes tool HTTP request bodies without confusing a tool's `params`
 * field with the optional request envelope used by integration callers.
 */
export class ToolRequestArguments {
  static normalize(body: unknown): Record<string, unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return {};

    const requestBody = body as Record<string, unknown>;
    const envelope = requestBody.params;
    if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
      return envelope as Record<string, unknown>;
    }

    return requestBody;
  }
}
