import { CliAgentService, type CliAgentEventResult, type CliAgentRunContext } from './CliAgentService';

function opencodeArgs(context: CliAgentRunContext): string[] {
  const args = ['opencode', 'run', '--format', 'json', '--auto', '--agent', 'sulla'];
  if (context.existingSession) args.push('--session', context.existingSession);
  if (context.model) args.push('--model', context.model);
  return args;
}

function opencodeEnv(context: CliAgentRunContext): Record<string, string> {
  const config: Record<string, any> = {
    agent: {
      sulla: {
        description: 'Sulla Desktop coding worker',
        mode:        'primary',
        prompt:      context.systemPrompt,
      },
    },
  };
  if (context.mcpSession) {
    config.mcp = {
      'sulla-native': {
        type:    'remote',
        url:     context.mcpSession.url,
        headers: { Authorization: context.mcpSession.header },
      },
    };
  }
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}

function parseOpenCodeEvent(event: any): CliAgentEventResult {
  const part = event?.part ?? {};
  const sessionId = event?.sessionID ?? part?.sessionID;
  if (event?.type === 'text' && typeof part.text === 'string') {
    return { text: part.text, sessionId };
  }
  if (event?.type === 'tool_use') {
    const state = part.state ?? {};
    const title = state.title || part.tool || 'tool';
    const output = typeof state.output === 'string' ? state.output : JSON.stringify(state.output ?? '');
    return {
      sessionId,
      activity:  state.status === 'completed' ? `Completed ${ title }` : `Using ${ title }`,
      toolEvent: state.status === 'completed' || state.status === 'error' ? {
        toolUseId:   String(part.callID ?? part.id ?? ''),
        toolName:    String(part.tool ?? 'tool'),
        input:       state.input,
        resultChars: output.length,
        isError:     state.status === 'error' || state.metadata?.exit > 0,
      } : undefined,
    };
  }
  if (event?.type === 'step_finish') {
    const tokens = part.tokens ?? {};
    return {
      sessionId,
      usage: {
        input_tokens:        tokens.input,
        output_tokens:       tokens.output,
        cached_input_tokens: tokens.cache?.read,
        cache_write:         tokens.cache?.write,
        cost_usd:            part.cost,
      },
    };
  }
  if (event?.type === 'error') {
    return { sessionId, error: event.error?.data?.message ?? event.error?.message ?? 'OpenCode failed.' };
  }
  if (event?.type === 'step_start') return { sessionId, activity: 'OpenCode is working…' };
  return { sessionId };
}

export class OpenCodeService extends CliAgentService {
  constructor() {
    super({
      id:             'opencode',
      name:           'OpenCode',
      autoModel:      'opencode',
      usageKey:       'opencodeUsage',
      missingMessage: 'OpenCode CLI is not installed in the VM. Run: npm install --prefix /mnt/data/npm-global -g opencode-ai',
      contextWindow:  200_000,
      accumulateUsage: true,
      buildArgs:      opencodeArgs,
      buildEnv:       opencodeEnv,
      parseEvent:     parseOpenCodeEvent,
      isResumeFailure: message => /session|resume|not found|invalid/i.test(message),
    });
  }
}

let instance: OpenCodeService | null = null;
export function getOpenCodeService(): OpenCodeService {
  instance ??= new OpenCodeService();
  return instance;
}
export function createOpenCodeService(model: string): OpenCodeService {
  const service = new OpenCodeService();
  service.setModel(model);
  return service;
}
export function resetOpenCodeService(): void { instance = null }
