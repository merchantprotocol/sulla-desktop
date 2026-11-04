// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { describe, expect, it } from 'vitest';
import { ToolCardFormatterRegistry } from '../../../tools/toolCardFormatterRegistry';
import { PrefixToolCardFormatter } from '../../../tools/toolCardStrategies/PrefixToolCardFormatter';
import { ToolCardText } from '../../../tools/toolCardStrategies/ToolCardText';
import type { ToolArguments, ToolCardFormatter } from '../../../tools/toolCardStrategies/ToolCardFormatter';

class CountingFormatter implements ToolCardFormatter {
  calls = 0;
  constructor(private readonly name: string, private readonly summary: string) {}
  supports(toolName: string): boolean { return toolName === this.name; }
  format(_toolName: string, _args: ToolArguments) { this.calls += 1; return { label: 'Exact', summary: this.summary }; }
}

describe('ToolCardFormatterRegistry', () => {
  it('calls the resolved exact strategy once per card', () => {
    // risk: side effects and inconsistent summaries from repeated strategy execution
    const exact = new CountingFormatter('git_special', 'exact summary');
    const registry = new ToolCardFormatterRegistry([exact], [new PrefixToolCardFormatter('git', 'Git')], new ToolCardText());
    expect(registry.format('git_special', {})).toEqual({ label: 'Exact', summary: 'exact summary', input: undefined, output: undefined, outputFormat: undefined });
    expect(exact.calls).toBe(1);
  });

  it('resolves exact behavior before a matching prefix label', () => {
    // risk: known tools silently losing domain-specific summaries
    const exact = new CountingFormatter('git_special', 'exact summary');
    const registry = new ToolCardFormatterRegistry([exact], [new PrefixToolCardFormatter('git', 'Git')], new ToolCardText());
    expect(registry.resolve('git_special')).toBe(exact);
    expect(registry.format('git_unknown', {})).toEqual({ label: 'Git', summary: 'Git Unknown' });
  });
});
