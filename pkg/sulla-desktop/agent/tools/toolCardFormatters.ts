// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { ToolCardCompositionRoot } from './toolCardCompositionRoot';
import type { ToolArguments, ToolCardDisplay } from './toolCardFormatterRegistry';
export type { ToolCardDisplay } from './toolCardFormatterRegistry';
const compositionRoot = new ToolCardCompositionRoot();
export function redactToolArgs(toolName: string, args: unknown): unknown { return compositionRoot.redactor.redact(toolName, args); }
export function formatToolCard(toolName: string, args: ToolArguments, result?: unknown): ToolCardDisplay { return compositionRoot.presenter.formatToolCard(toolName, args, result); }
export function formatToolResult(toolName: string, args: ToolArguments, result: unknown, error?: string | null) { return compositionRoot.presenter.formatToolResult(toolName, args, result, error); }
