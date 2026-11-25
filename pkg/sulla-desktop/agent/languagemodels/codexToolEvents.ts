// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface CodexToolEvent {
  toolUseId:   string;
  toolName:    string;
  input?:      unknown;
  result?:     unknown;
  error?:      string;
  resultChars: number;
  isError?:    boolean;
}

/** Converts completed Codex JSON items into complete tool transcript events. */
export class CodexToolEventEmitter {
  emit(eventType: string, item: any, callback?: (event: CodexToolEvent) => void): void {
    if (eventType !== 'item.completed' || !callback) return;
    const event = this.eventForItem(item);
    if (!event) return;
    try { callback(event) } catch { /* provider callbacks are best-effort */ }
  }

  private eventForItem(item: any): CodexToolEvent | null {
    const kind = item?.item_type ?? item?.type;
    const toolUseId = item?.id ?? item?.call_id;
    if (typeof toolUseId !== 'string' || !toolUseId) return null;

    const failed = item?.status === 'failed' || item?.status === 'error' || Boolean(item?.error) ||
      (typeof item?.exit_code === 'number' && item.exit_code !== 0);
    const error = typeof item?.error === 'string'
      ? item.error
      : item?.error === undefined ? undefined : JSON.stringify(item.error, null, 2) ?? String(item.error);

    switch (kind) {
    case 'command_execution': {
      const result = item.aggregated_output ?? item.output ?? item.stderr ?? item.stdout;
      return {
        toolUseId,
        toolName:    'command_execution',
        input:       { command: item.command, cwd: item.cwd },
        result,
        error:       error ?? (failed && typeof item.stderr === 'string' ? item.stderr : undefined),
        resultChars: this.serializedLength(result),
        isError:     failed || (typeof item.exit_code === 'number' && item.exit_code !== 0) || undefined,
      };
    }
    case 'mcp_tool_call': {
      const server = typeof item.server === 'string' && item.server ? `${ item.server }/` : '';
      const tool = typeof item.tool === 'string' && item.tool ? item.tool : 'mcp_tool_call';
      const result = item.result ?? item.output;
      return {
        toolUseId,
        toolName:    `${ server }${ tool }`,
        input:       item.arguments ?? item.input,
        result,
        error:       error ?? (failed && result !== undefined ? this.toText(result) : undefined),
        resultChars: this.serializedLength(result ?? item.error),
        isError:     failed || undefined,
      };
    }
    case 'web_search': {
      const result = item.result ?? item.output;
      return {
        toolUseId,
        toolName:    'web_search',
        input:       { query: item.query },
        result,
        error:       error ?? (failed && result !== undefined ? this.toText(result) : undefined),
        resultChars: this.serializedLength(result),
        isError:     failed || undefined,
      };
    }
    case 'file_change': {
      const result = item.changes ?? item.output ?? item.result;
      return {
        toolUseId,
        toolName:    'file_change',
        input:       { changes: item.changes },
        result,
        error:       error ?? (failed && result !== undefined ? this.toText(result) : undefined),
        resultChars: this.serializedLength(result),
        isError:     failed || undefined,
      };
    }
    default:
      return null;
    }
  }

  private toText(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
  }

  private serializedLength(value: unknown): number {
    if (typeof value === 'string') return value.length;
    if (value === undefined || value === null) return 0;
    try { return JSON.stringify(value).length }
    catch { return String(value).length }
  }
}
