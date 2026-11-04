// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { ToolArgumentRedactor, ToolCardCompositionRoot, type ToolCardDisplay, type ToolArguments } from './toolCardFormatterRegistry';
export type { ToolCardDisplay } from './toolCardFormatterRegistry';
const provider = new ToolCardCompositionRoot();
const redactor: ToolArgumentRedactor = provider.redactor;
export function redactToolArgs(toolName: string, args: unknown): unknown { return redactor.redact(toolName, args); }
export function formatToolCard(toolName: string, args: ToolArguments, result?: unknown): ToolCardDisplay { return provider.presenter.formatToolCard(toolName, args, result); }
export function formatToolResult(toolName: string, args: ToolArguments, result: unknown, error?: string | null) { return provider.presenter.formatToolResult(toolName, args, result, error); }
