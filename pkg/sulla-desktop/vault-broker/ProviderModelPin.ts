// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Which models a pinned provider bridge accepts. A bridge is pinned to the
 * model its CLI was launched with; a request for any other model is refused.
 * Claude Code's own aliases ("opus", "sonnet", "haiku") are resolved by the
 * CLI to a full id ("claude-opus-5-5") before it sends the request, so a pin
 * on an alias accepts that family and nothing else.
 */
export class ProviderModelPin {
  private static readonly FAMILIES: Readonly<Record<string, RegExp>> = {
    opus:   /^claude-opus-[\w.-]+(\[[\w]+\])?$/,
    sonnet: /^claude-sonnet-[\w.-]+(\[[\w]+\])?$/,
    haiku:  /^claude-haiku-[\w.-]+(\[[\w]+\])?$/,
  };

  /** True when `model` is one of `pins`, or of the family a pinned alias names. No pins: anything goes. */
  static allows(model: unknown, pins: readonly string[] | undefined): boolean {
    if (!pins?.length) return true;
    if (typeof model !== 'string' || !model) return false;
    return pins.some(pin => pin === model || (ProviderModelPin.FAMILIES[pin.toLowerCase()]?.test(model) ?? false));
  }

  /** The request body's model, if it names one. */
  static requested(body: unknown): unknown {
    return body && typeof body === 'object' && !Array.isArray(body) && 'model' in body ? (body as { model?: unknown }).model : undefined;
  }
}
