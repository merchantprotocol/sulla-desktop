// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Golden transcripts. Each fixture replays recorded provider replies through
 * runTurn and pins the exact requests sent, the tools invoked and the
 * result. Plain data with no imports, so the same file runs on Node,
 * Workers and Hermes.
 */

const webSearch = {
  name:        'web/web_search',
  description: 'Search the web.',
  inputSchema: {
    type:       'object',
    properties: {
      query: { type: 'string', description: 'Search terms' },
      limit: { type: 'integer' },
    },
    required: ['query'],
  },
  sideEffect: 'read',
};

const sendEmail = {
  name:        'email/send',
  description: 'Send an email.',
  inputSchema: {
    type:       'object',
    properties: { to: { type: 'string' }, body: { type: 'string' } },
    required:   ['to', 'body'],
  },
  sideEffect: 'irreversible',
};

const searchResult = { success: true, result: { hits: [{ title: 'Portland weather', snippet: 'Rain, 12°C' }] } };

export const fixtures = [
  {
    name:       'anthropic: one tool call then answer',
    api:        'anthropic-messages',
    providerId: 'anthropic',
    model:      'claude-sonnet-5-5',
    system:     'You are Sulla.',
    messages:   [{ role: 'user', content: 'Weather in Portland?' }],
    tools:      [webSearch],
    replies:    [
      {
        status: 200,
        body:   {
          model:       'claude-sonnet-5-5',
          stop_reason: 'tool_use',
          content:     [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 'toolu_1', name: 'web__web_search', input: { query: 'Portland weather' } },
          ],
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40 },
        },
      },
      {
        status: 200,
        body:   {
          model:       'claude-sonnet-5-5',
          stop_reason: 'end_turn',
          content:     [{ type: 'text', text: 'Rainy, 12°C.' }],
          usage:       { input_tokens: 150, output_tokens: 10 },
        },
      },
    ],
    toolResults: { 'web/web_search': searchResult },
    expect:      {
      status:      'completed',
      finalText:   'Rainy, 12°C.',
      iterations:  2,
      usage:       { inputTokens: 250, outputTokens: 30, cachedTokens: 40 },
      invocations: [{ name: 'web/web_search', args: { query: 'Portland weather' } }],
      roles:       ['user', 'assistant', 'tool', 'assistant'],
      requests:    [
        {
          url:     'https://api.anthropic.com/v1/messages',
          headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
          body:    {
            model:      'claude-sonnet-5-5',
            max_tokens: 4096,
            messages:   [{ role: 'user', content: [{ type: 'text', text: 'Weather in Portland?' }] }],
            system:     'You are Sulla.',
            tools:      [{
              name:         'web__web_search',
              description:  'Search the web.',
              input_schema: {
                type:       'object',
                properties: { query: { type: 'string', description: 'Search terms' }, limit: { type: 'integer' } },
                required:   ['query'],
              },
            }],
          },
        },
        {
          url:     'https://api.anthropic.com/v1/messages',
          headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
          body:    {
            model:      'claude-sonnet-5-5',
            max_tokens: 4096,
            messages:   [
              { role: 'user', content: [{ type: 'text', text: 'Weather in Portland?' }] },
              {
                role:    'assistant',
                content: [
                  { type: 'text', text: 'Let me check.' },
                  { type: 'tool_use', id: 'toolu_1', name: 'web__web_search', input: { query: 'Portland weather' } },
                ],
              },
              {
                role:    'user',
                content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"hits":[{"title":"Portland weather","snippet":"Rain, 12°C"}]}' }],
              },
            ],
            system: 'You are Sulla.',
            tools:  [{
              name:         'web__web_search',
              description:  'Search the web.',
              input_schema: {
                type:       'object',
                properties: { query: { type: 'string', description: 'Search terms' }, limit: { type: 'integer' } },
                required:   ['query'],
              },
            }],
          },
        },
      ],
    },
  },
  {
    name:       'openai: stringified args, prefixed name, type coercion',
    api:        'openai-chat',
    providerId: 'openai',
    model:      'gpt-5',
    system:     'You are Sulla.',
    messages:   [{ role: 'user', content: 'Weather in Portland?' }],
    tools:      [webSearch],
    replies:    [
      {
        status: 200,
        body:   {
          model:   'gpt-5',
          choices: [{
            finish_reason: 'tool_calls',
            message:       {
              role:       'assistant',
              content:    null,
              tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'functions.web__web_search', arguments: '{"query":"Portland weather","limit":"3"}' } }],
            },
          }],
          usage: { prompt_tokens: 80, completion_tokens: 15, prompt_tokens_details: { cached_tokens: 0 } },
        },
      },
      {
        status: 200,
        body:   {
          model:   'gpt-5',
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Rainy, 12°C.' } }],
          usage:   { prompt_tokens: 120, completion_tokens: 8 },
        },
      },
    ],
    toolResults: { 'web/web_search': searchResult },
    expect:      {
      status:      'completed',
      finalText:   'Rainy, 12°C.',
      iterations:  2,
      usage:       { inputTokens: 200, outputTokens: 23, cachedTokens: 0 },
      invocations: [{ name: 'web/web_search', args: { query: 'Portland weather', limit: 3 } }],
      roles:       ['user', 'assistant', 'tool', 'assistant'],
      requests:    [
        {
          url:     'https://api.openai.com/v1/chat/completions',
          headers: { 'content-type': 'application/json' },
          body:    {
            model:    'gpt-5',
            messages: [
              { role: 'system', content: 'You are Sulla.' },
              { role: 'user', content: 'Weather in Portland?' },
            ],
            tools: [{
              type:     'function',
              function: {
                name:        'web__web_search',
                description: 'Search the web.',
                parameters:  {
                  type:       'object',
                  properties: { query: { type: 'string', description: 'Search terms' }, limit: { type: 'integer' } },
                  required:   ['query'],
                },
              },
            }],
          },
        },
        {
          url:     'https://api.openai.com/v1/chat/completions',
          headers: { 'content-type': 'application/json' },
          body:    {
            model:    'gpt-5',
            messages: [
              { role: 'system', content: 'You are Sulla.' },
              { role: 'user', content: 'Weather in Portland?' },
              {
                role:       'assistant',
                content:    null,
                tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'web__web_search', arguments: '{"query":"Portland weather","limit":"3"}' } }],
              },
              { role: 'tool', tool_call_id: 'call_a', content: '{"hits":[{"title":"Portland weather","snippet":"Rain, 12°C"}]}' },
            ],
            tools: [{
              type:     'function',
              function: {
                name:        'web__web_search',
                description: 'Search the web.',
                parameters:  {
                  type:       'object',
                  properties: { query: { type: 'string', description: 'Search terms' }, limit: { type: 'integer' } },
                  required:   ['query'],
                },
              },
            }],
          },
        },
      ],
    },
  },
  {
    name:       'openai-compatible (xAI): exec meta call, unknown tool, missing arg',
    api:        'openai-chat',
    baseUrl:    'https://api.x.ai/v1/',
    providerId: 'xai',
    model:      'grok-4',
    messages:   [{ role: 'user', content: 'Search for Sulla' }],
    tools:      [webSearch],
    replies:    [
      {
        status: 200,
        body:   {
          choices: [{
            finish_reason: 'tool_calls',
            message:       {
              content:    'Searching.',
              tool_calls: [
                { id: 'c1', function: { name: 'exec', arguments: '{"tool_id":"web/web_search","query":"Sulla"}' } },
                { id: 'c2', function: { name: 'browser_open', arguments: '{"url":"https://example.com"}' } },
                { id: 'c3', function: { name: 'WEB__WEB_SEARCH', arguments: '{"limit":2}' } },
              ],
            },
          }],
          usage: { prompt_tokens: 50, completion_tokens: 30 },
        },
      },
      {
        status: 200,
        body:   { choices: [{ finish_reason: 'stop', message: { content: 'Found it.' } }], usage: { prompt_tokens: 90, completion_tokens: 4 } },
      },
    ],
    toolResults: { 'web/web_search': searchResult },
    expect:      {
      status:       'completed',
      finalText:    'Found it.',
      iterations:   2,
      usage:        { inputTokens: 140, outputTokens: 34, cachedTokens: 0 },
      invocations:  [{ name: 'web/web_search', args: { query: 'Sulla' } }],
      roles:        ['user', 'assistant', 'tool', 'tool', 'tool', 'assistant'],
      requestUrls:  ['https://api.x.ai/v1/chat/completions', 'https://api.x.ai/v1/chat/completions'],
      toolMessages: [
        '{"hits":[{"title":"Portland weather","snippet":"Rain, 12°C"}]}',
        'Error: There is no tool named "browser_open". Only the listed tools can be called.',
        'Error: Invalid arguments: "query" is required (Search terms). Expected { query: string, limit?: integer }.',
      ],
    },
  },
  {
    name:       'irreversible tool waits for approval; declined',
    api:        'anthropic-messages',
    providerId: 'anthropic',
    model:      'claude-sonnet-5-5',
    messages:   [{ role: 'user', content: 'Email Bob that I am late' }],
    tools:      [sendEmail],
    approvals:  { 'email/send': false },
    replies:    [
      {
        status: 200,
        body:   {
          stop_reason: 'tool_use',
          content:     [{ type: 'tool_use', id: 't1', name: 'email__send', input: { to: 'bob@example.com', body: 'Running late' } }],
          usage:       { input_tokens: 40, output_tokens: 12 },
        },
      },
      {
        status: 200,
        body:   { stop_reason: 'end_turn', content: [{ type: 'text', text: 'OK, I did not send it.' }], usage: { input_tokens: 60, output_tokens: 8 } },
      },
    ],
    toolResults: { 'email/send': { success: true, result: 'sent' } },
    expect:      {
      status:       'completed',
      finalText:    'OK, I did not send it.',
      iterations:   2,
      invocations:  [],
      approvals:    [{ name: 'email/send', args: { to: 'bob@example.com', body: 'Running late' } }],
      toolMessages: ['Error: the user did not approve "email/send".'],
    },
  },
  {
    name:       'iteration guard stops a model that never finishes',
    api:        'anthropic-messages',
    providerId: 'anthropic',
    model:      'claude-sonnet-5-5',
    messages:   [{ role: 'user', content: 'Loop' }],
    tools:      [webSearch],
    budget:     { maxIterations: 2 },
    replies:    [
      { status: 200, body: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'web__web_search', input: { query: 'x' } }], usage: { input_tokens: 10, output_tokens: 5 } } },
      { status: 200, body: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'b', name: 'web__web_search', input: { query: 'y' } }], usage: { input_tokens: 10, output_tokens: 5 } } },
    ],
    toolResults: { 'web/web_search': searchResult },
    expect:      {
      status:      'max_iterations',
      iterations:  2,
      invocations: [{ name: 'web/web_search', args: { query: 'x' } }, { name: 'web/web_search', args: { query: 'y' } }],
      roles:       ['user', 'assistant', 'tool', 'assistant', 'tool'],
    },
  },
  {
    name:       'token budget stops before running more tools',
    api:        'openai-chat',
    providerId: 'openai',
    model:      'gpt-5',
    messages:   [{ role: 'user', content: 'Search' }],
    tools:      [webSearch],
    budget:     { maxTotalTokens: 100 },
    replies:    [
      {
        status: 200,
        body:   {
          choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'k', function: { name: 'web__web_search', arguments: '{"query":"x"}' } }] } }],
          usage:   { prompt_tokens: 120, completion_tokens: 30 },
        },
      },
    ],
    toolResults: { 'web/web_search': searchResult },
    expect:      {
      status:       'token_budget',
      iterations:   1,
      invocations:  [],
      roles:        ['user', 'assistant', 'tool'],
      toolMessages: ['Not run: the turn stopped (token_budget).'],
    },
  },
  {
    name:       'provider auth error is reported once and redacted',
    api:        'openai-chat',
    providerId: 'openai',
    model:      'gpt-5',
    messages:   [{ role: 'user', content: 'Hi' }],
    tools:      [],
    replies:    [
      { status: 401, body: { error: { message: 'Incorrect API key provided: sk-test-SECRET-should-never-leak.' } } },
    ],
    toolResults: {},
    expect:      {
      status:     'provider_error',
      iterations: 1,
      error:      { code: 'auth', status: 401, message: 'Provider returned 401: Incorrect API key provided: [redacted].' },
      roles:      ['user'],
    },
  },
];
