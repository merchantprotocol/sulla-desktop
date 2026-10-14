import { CliAgentService, type CliAgentEventResult, type CliAgentRunContext, writeCursorMcpPlugin } from './CliAgentService';

function cursorArgs(context: CliAgentRunContext): string[] {
  const args = ['cursor-agent', '-p', '--output-format', 'stream-json', '--stream-partial-output', '--force', '--approve-mcps', '--trust'];
  if (context.mcpConfigPath) args.push('--plugin-dir', context.mcpConfigPath);
  if (context.existingSession) args.push('--resume', context.existingSession);
  if (context.model) args.push('--model', context.model);
  return args;
}

function parseCursorEvent(event: any): CliAgentEventResult {
  const sessionId = event?.session_id ?? event?.sessionId ?? event?.chat_id ?? event?.chatId;
  if (event?.type === 'system' && event?.subtype === 'init') {
    return { sessionId, activity: 'Cursor Agent session started' };
  }
  if (event?.type === 'assistant') {
    const blocks = event?.message?.content ?? event?.content ?? [];
    const text = Array.isArray(blocks)
      ? blocks.filter((block: any) => block?.type === 'text').map((block: any) => block.text ?? '').join('')
      : typeof blocks === 'string' ? blocks : '';
    const tool = Array.isArray(blocks) ? blocks.find((block: any) => block?.type === 'tool_use') : null;
    // With --stream-partial-output only timestamped events without a
    // model_call_id contain new text. Pre-tool and final flushes repeat it.
    const isNewDelta = typeof event.timestamp_ms === 'number' && !event.model_call_id;
    return {
      text: isNewDelta && text ? text : undefined,
      sessionId,
      activity: tool ? `Using ${ tool.name ?? 'tool' }` : undefined,
    };
  }
  if (event?.type === 'tool_call' || event?.type === 'tool' || event?.type === 'tool_use') {
    const call = event.tool_call ?? event.toolCall ?? event;
    const [kind, details] = Object.entries(call).find(([, value]) => value && typeof value === 'object') ?? ['tool', call];
    const detail = details as any;
    const result = detail?.result ?? call.result ?? call.output ?? event.result ?? '';
    const completed = event.subtype === 'completed' || event.status === 'completed' || result !== '';
    return {
      sessionId,
      activity: `Using ${ kind }`,
      toolEvent: completed ? {
        toolUseId:   String(event.call_id ?? call.id ?? call.call_id ?? call.callId ?? ''),
        toolName:    String(kind),
        input:       detail?.args ?? call.input ?? call.args,
        resultChars: typeof result === 'string' ? result.length : JSON.stringify(result).length,
        isError:     event.status === 'error' || call.is_error === true || !!detail?.result?.error,
      } : undefined,
    };
  }
  if (event?.type === 'result') {
    return {
      sessionId,
      usage: {
        ...(event.usage ?? {}),
        duration_ms: event.duration_ms,
        cost_usd:    event.total_cost_usd,
      },
      error: event.is_error || event.subtype === 'error' ? String(event.error ?? event.result ?? 'Cursor Agent failed.') : undefined,
    };
  }
  if (event?.type === 'error') return { sessionId, error: String(event.message ?? event.error ?? 'Cursor Agent failed.') };
  return { sessionId };
}

export class CursorAgentService extends CliAgentService {
  constructor() {
    super({
      id:             'cursor',
      name:           'Cursor Agent',
      autoModel:      'cursor',
      missingMessage: 'Cursor Agent CLI is not installed in the VM. Run: curl https://cursor.com/install -fsS | bash',
      contextWindow:  200_000,
      systemPromptInUserMessage: true,
      buildArgs:      cursorArgs,
      parseEvent:     parseCursorEvent,
      writeMcpConfig: session => writeCursorMcpPlugin(session),
      isResumeFailure: message => /session|chat|resume|not found|invalid/i.test(message),
    });
  }
}

let instance: CursorAgentService | null = null;
export function getCursorAgentService(): CursorAgentService {
  instance ??= new CursorAgentService();
  return instance;
}
export function createCursorAgentService(model: string): CursorAgentService {
  const service = new CursorAgentService();
  service.setModel(model);
  return service;
}
export function resetCursorAgentService(): void { instance = null }
