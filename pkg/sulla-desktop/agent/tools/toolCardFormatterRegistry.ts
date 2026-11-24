// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import type { ToolArguments, ToolCardDisplay, ToolCardFormatter } from './toolCardStrategies/ToolCardFormatter';
import { PrefixToolCardFormatter } from './toolCardStrategies/PrefixToolCardFormatter';
import { ToolCardText } from './toolCardStrategies/ToolCardText';
export type { ToolArguments, ToolCardDisplay, ToolCardFormatter } from './toolCardStrategies/ToolCardFormatter';

export class ToolCardFormatterRegistry {
  constructor(
    private readonly exactFormatters: readonly ToolCardFormatter[],
    private readonly prefixFormatters: readonly PrefixToolCardFormatter[],
    private readonly text: ToolCardText,
  ) {}
  resolve(toolName: string): ToolCardFormatter | undefined {
    return this.exactFormatters.find(formatter => formatter.supports(toolName))
      ?? this.prefixFormatters.find(formatter => formatter.supports(toolName));
  }
  format(toolName: string, args: ToolArguments, result?: unknown): ToolCardDisplay {
    const exact = this.exactFormatters.find(formatter => formatter.supports(toolName));
    if (exact) {
      const partial = exact.format(toolName, args, result);
      return { label: partial.label ?? this.fallbackLabel(toolName), summary: partial.summary ?? toolName,
        input: partial.input, output: partial.output, outputFormat: partial.outputFormat };
    }
    return { label: this.fallbackLabel(toolName), summary: this.humanName(toolName) };
  }
  formatResult(toolName: string, args: ToolArguments, result: unknown): Pick<ToolCardDisplay, 'output' | 'outputFormat'> {
    const formatter = this.exactFormatters.find(candidate => candidate.supports(toolName));
    if (!formatter) return { output: this.text.extractOutput(result) };
    const partial = formatter.format(toolName, args, result);
    return { output: partial.output ?? this.text.extractOutput(result), outputFormat: partial.outputFormat };
  }
  private fallbackLabel(toolName: string): string {
    return this.prefixFormatters.find(formatter => formatter.supports(toolName))?.displayLabel ?? 'Tool';
  }
  private humanName(toolName: string): string {
    return toolName.replace(/[_-]/g, ' ').replace(/\b\w/g, character => character.toUpperCase());
  }
}

export class ToolCardPresenter {
  constructor(private readonly registry: ToolCardFormatterRegistry) {}
  formatToolCard(toolName: string, args: ToolArguments, result?: unknown): ToolCardDisplay { return this.registry.format(toolName, args, result); }
  formatToolResult(toolName: string, args: ToolArguments, result: unknown, _error?: string | null) { return this.registry.formatResult(toolName, args, result); }
}
