// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import type { ToolArguments, ToolCardDisplay, ToolCardFormatter } from './ToolCardFormatter';
export class PrefixToolCardFormatter implements ToolCardFormatter {
  constructor(private readonly prefix: string, readonly displayLabel: string) {}
  supports(toolName: string): boolean { return toolName.startsWith(this.prefix); }
  format(_toolName: string, _args: ToolArguments, _result?: unknown): Partial<ToolCardDisplay> { return {}; }
}
