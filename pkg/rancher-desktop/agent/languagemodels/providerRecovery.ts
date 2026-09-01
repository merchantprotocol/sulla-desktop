export type LLMFailureKind =
  | 'auth'
  | 'quota'
  | 'rate_limit'
  | 'timeout'
  | 'unavailable'
  | 'empty'
  | 'interrupted'
  | 'unknown';

export interface LLMFailureRecovery {
  kind:            LLMFailureKind;
  retryPrimary:    boolean;
  fallbackAllowed: boolean;
  userMessage:     string;
}

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-proj-[A-Za-z0-9_-]{8,}\b/g,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
];

export function redactLLMFailureMessage(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value ?? '');
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, '[redacted]');
  }
  return text;
}

export function classifyLLMFailure(error: unknown): LLMFailureRecovery {
  const name = (error as any)?.name;
  const message = redactLLMFailureMessage(error);
  const lower = `${ name || '' } ${ message }`.toLowerCase();

  if (name === 'AbortError' || lower.includes('aborted') || lower.includes('aborterror')) {
    return {
      kind:            'interrupted',
      retryPrimary:    false,
      fallbackAllowed: false,
      userMessage:     'The prior model run was interrupted.',
    };
  }

  if (/\b401\b/.test(lower) || lower.includes('unauthorized') || lower.includes('invalid api key')) {
    return {
      kind:            'auth',
      retryPrimary:    false,
      fallbackAllowed: true,
      userMessage:     'The selected model provider rejected its credentials.',
    };
  }

  if (
    /\b402\b/.test(lower) ||
    lower.includes('balance exhausted') ||
    lower.includes('usage balance') ||
    lower.includes('weekly limit') ||
    lower.includes('session limit')
  ) {
    return {
      kind:            'quota',
      retryPrimary:    false,
      fallbackAllowed: true,
      userMessage:     'The selected model provider is out of usable quota.',
    };
  }

  if (/\b429\b/.test(lower) || lower.includes('rate limit') || lower.includes('too many requests')) {
    return {
      kind:            'rate_limit',
      retryPrimary:    true,
      fallbackAllowed: true,
      userMessage:     'The selected model provider is rate limited.',
    };
  }

  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('etimedout')) {
    return {
      kind:            'timeout',
      retryPrimary:    true,
      fallbackAllowed: true,
      userMessage:     'The selected model provider timed out.',
    };
  }

  if (
    lower.includes('no response') ||
    lower.includes('empty response') ||
    lower.includes('returned empty') ||
    lower.includes('no extractable prompt')
  ) {
    return {
      kind:            'empty',
      retryPrimary:    true,
      fallbackAllowed: true,
      userMessage:     'The selected model provider returned no usable response.',
    };
  }

  if (
    lower.includes('event stream') ||
    lower.includes('dropped event') ||
    lower.includes('stream lag') ||
    lower.includes('exited with code null') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('network') ||
    lower.includes('service unavailable') ||
    /\b5\d\d\b/.test(lower)
  ) {
    return {
      kind:            'unavailable',
      retryPrimary:    true,
      fallbackAllowed: true,
      userMessage:     'The selected model provider was temporarily unavailable.',
    };
  }

  return {
    kind:            'unknown',
    retryPrimary:    false,
    fallbackAllowed: true,
    userMessage:     'The selected model provider failed.',
  };
}

export function sameLLMRoute(a: { provider: string; model: string }, b: { provider: string; model: string }): boolean {
  return a.provider.trim().toLowerCase() === b.provider.trim().toLowerCase() &&
    a.model.trim().toLowerCase() === b.model.trim().toLowerCase();
}
