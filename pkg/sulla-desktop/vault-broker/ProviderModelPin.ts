// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Which models a pinned provider bridge accepts. A bridge is pinned to the
 * model its CLI was launched with; a request for any other model is refused.
 * Claude Code's own aliases are resolved by the CLI to a full id before it
 * sends the request, so a pin on an alias accepts that family and nothing else.
 */
export class ProviderModelPin {
  /**
   * Claude Code decorates aliases with context selectors such as `sonnet[1m]`.
   * The request sent upstream contains the resolved model id instead, so the
   * bridge must compare the underlying alias family rather than the selector.
   * Alias names come from Claude Code's refreshed model catalog, including
   * families Sulla did not know at build time. Exact model pins remain exact.
   */
  private static family(pin: string): RegExp | undefined {
    const alias = pin.toLowerCase().match(/^([a-z][a-z0-9-]*)(?:\[[a-z0-9-]+\])?$/)?.[1];

    if (!alias || alias.startsWith('claude-')) return undefined;
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    return new RegExp(`^claude-${ escaped }-[\\w.-]+(?:\\[[\\w]+\\])?$`);
  }

  /** True when `model` is one of `pins`, or of the family a pinned alias names. No pins: anything goes. */
  static allows(model: unknown, pins: readonly string[] | undefined): boolean {
    if (!pins?.length) return true;
    if (typeof model !== 'string' || !model) return false;
    return pins.some(pin => pin === model || (ProviderModelPin.family(pin)?.test(model) ?? false));
  }

  /** The request body's model, if it names one. */
  static requested(body: unknown): unknown {
    return body && typeof body === 'object' && !Array.isArray(body) && 'model' in body ? (body as { model?: unknown }).model : undefined;
  }
}
