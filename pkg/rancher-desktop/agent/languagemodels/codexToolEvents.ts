export interface CodexToolEvent {
  toolUseId:   string;
  toolName:    string;
  input?:      unknown;
  resultChars: number;
  isError?:    boolean;
}

function serializedLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (value === undefined || value === null) return 0;
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}

/** Normalize a completed `codex exec --json` tool item for conversation logs. */
export function codexToolEventForItem(item: any): CodexToolEvent | null {
  const kind = item?.item_type ?? item?.type;
  const toolUseId = item?.id ?? item?.call_id;
  if (typeof toolUseId !== 'string' || !toolUseId) return null;

  const failed = item?.status === 'failed' || item?.status === 'error' || Boolean(item?.error);

  switch (kind) {
  case 'command_execution': {
    const result = item.aggregated_output ?? item.output ?? item.stderr ?? item.stdout;
    return {
      toolUseId,
      toolName:    'command_execution',
      input:       { command: item.command, cwd: item.cwd },
      resultChars: serializedLength(result),
      isError:     failed || (typeof item.exit_code === 'number' && item.exit_code !== 0) || undefined,
    };
  }
  case 'mcp_tool_call': {
    const server = typeof item.server === 'string' && item.server ? `${ item.server }/` : '';
    const tool = typeof item.tool === 'string' && item.tool ? item.tool : 'mcp_tool_call';
    return {
      toolUseId,
      toolName:    `${ server }${ tool }`,
      input:       item.arguments ?? item.input,
      resultChars: serializedLength(item.result ?? item.output ?? item.error),
      isError:     failed || undefined,
    };
  }
  case 'web_search':
    return {
      toolUseId,
      toolName:    'web_search',
      input:       { query: item.query },
      resultChars: serializedLength(item.result ?? item.output),
      isError:     failed || undefined,
    };
  case 'file_change':
    return {
      toolUseId,
      toolName:    'file_change',
      input:       { changes: item.changes },
      resultChars: serializedLength(item.changes),
      isError:     failed || undefined,
    };
  default:
    return null;
  }
}

/** Forward exactly one completed Codex tool item to the stream callback. */
export function emitCodexToolEvent(
  eventType: string,
  item: any,
  callback?: (event: CodexToolEvent) => void,
): void {
  if (eventType !== 'item.completed' || !callback) return;
  const event = codexToolEventForItem(item);
  if (!event) return;
  try { callback(event) } catch { /* provider callbacks are best-effort */ }
}
