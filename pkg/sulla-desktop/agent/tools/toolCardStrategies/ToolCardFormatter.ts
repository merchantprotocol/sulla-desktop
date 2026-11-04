// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface ToolCardDisplay {
  label: string;
  summary: string;
  input?: string;
  output?: string;
  outputFormat?: 'text' | 'code' | 'url' | 'json';
}
export type ToolArguments = Record<string, unknown>;
export interface ToolCardFormatter {
  supports(toolName: string): boolean;
  format(toolName: string, args: ToolArguments, result?: unknown): Partial<ToolCardDisplay>;
}
