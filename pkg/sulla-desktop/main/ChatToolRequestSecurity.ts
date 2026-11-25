// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface ChatToolRequest {
  header(name: string): string | undefined;
  headers: { authorization?: string };
}

export interface ChatRequestTool<TParams, TResult> {
  call(params: TParams): TResult;
  callWithVerifiedSession?: (threadId: string | undefined, params: TParams) => TResult;
}

/** Reads request credentials and keeps verified-session tool dispatch explicit. */
export class ChatToolRequestSecurity {
  readonly sessionToken: string | undefined;
  readonly bearer: string | undefined;

  constructor(request: ChatToolRequest) {
    this.sessionToken = request.header('X-Sulla-Tool-Session')?.trim();
    this.bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  }

  readonly invoke = <TParams, TResult>(
    tool: ChatRequestTool<TParams, TResult>,
    category: string,
    toolName: string,
    threadId: string | undefined,
    params: TParams,
  ): TResult => {
    if (category === 'agents' && toolName === 'answer_decision' && tool.callWithVerifiedSession) {
      return tool.callWithVerifiedSession(threadId, params);
    }
    return tool.call(params);
  };
}
