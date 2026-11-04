// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ToolArguments, ToolCardDisplay, ToolCardFormatter } from './ToolCardFormatter';
export type ToolCardFormattingRule = (args: ToolArguments, result?: unknown) => Partial<ToolCardDisplay>;
export abstract class MappedToolCardFormatter implements ToolCardFormatter {
  constructor(private readonly rules: Readonly<Record<string, ToolCardFormattingRule>>) {}
  supports(toolName: string): boolean { return Object.prototype.hasOwnProperty.call(this.rules, toolName); }
  format(toolName: string, args: ToolArguments, result?: unknown): Partial<ToolCardDisplay> {
    return this.rules[toolName]?.(args, result) ?? {};
  }
}
