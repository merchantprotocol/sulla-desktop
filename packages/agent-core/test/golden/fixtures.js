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

const writeFile = {
  name:        'fs/write_file',
  description: 'Write a file.',
  inputSchema: {
    type:       'object',
    properties: { path: { type: 'string' }, text: { type: 'string' } },
    required:   ['path', 'text'],
  },
  sideEffect: 'write',
};

/** Untyped callers can leave sideEffect out; the core must still ask. */
const tidyNotes = { name: 'notes/tidy', description: 'Tidy notes.' };

/** A write relayed to the user's Mac: the host sets requiresApproval (PLAN.md §4.4). */
const relayedWrite = { ...writeFile, requiresApproval: true, placements: ['desktop'], relayable: true };

const readNote = {
  name:        'notes/read',
  description: 'Read a note.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  sideEffect:  'read',
};

const searchResult = { success: true, result: { hits: [{ title: 'Portland weather', snippet: 'Rain, 12°C' }] } };

const CUT_OFF = 'Not run: output was cut off at the output token limit, so this call may be incomplete. Send it again with shorter arguments.';

/** Server-sent events text: `[eventName, data]` pairs, or bare data. */
function sse(events, eol) {
  const nl = eol || '\n';
  return events.map((ev) => {
    const [name, data] = Array.isArray(ev) ? ev : [undefined, ev];
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    return `${ name ? `event: ${ name }${ nl }` : '' }data: ${ payload }${ nl }${ nl }`;
  }).join('');
}

/** Split text into small chunks so lines and CRLFs straddle chunk edges. */
function chunked(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function anthropicStream(model, blocks, stopReason, usage) {
  const events = [['message_start', { type: 'message_start', message: { model, usage: { input_tokens: usage.input, cache_read_input_tokens: usage.cacheRead || 0, output_tokens: 1 } } }]];
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
      for (const t of b.deltas) events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } }]);
    } else {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }]);
      for (const j of b.json) events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: j } }]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push(['ping', { type: 'ping' }]);
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: usage.output } }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return chunked(sse(events), 7);
}

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
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 },
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
      usage:       { inputTokens: 300, outputTokens: 30, cachedTokens: 40, cacheWriteTokens: 10 },
      events:      ['model_request', 'usage', 'text:Let me check.', 'tool_call:toolu_1', 'tool_result:toolu_1:ok', 'model_request', 'usage', 'text:Rainy, 12°C.', 'done:completed'],
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
      usage:       { inputTokens: 200, outputTokens: 23, cachedTokens: 0, cacheWriteTokens: 0 },
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
    adapterOptions: { baseUrl: 'https://api.x.ai/v1/' },
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
      usage:        { inputTokens: 140, outputTokens: 34, cachedTokens: 0, cacheWriteTokens: 0 },
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
  {
    name:       'a tool with no sideEffect is refused when the host cannot ask',
    api:        'openai-chat',
    providerId: 'openai',
    model:      'gpt-5',
    messages:   [{ role: 'user', content: 'Tidy my notes' }],
    tools:      [tidyNotes],
    replies:    [
      {
        status: 200,
        body:   { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'n1', function: { name: 'notes__tidy', arguments: '{}' } }] } }], usage: { prompt_tokens: 20, completion_tokens: 5 } },
      },
      { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'I could not.' } }], usage: { prompt_tokens: 30, completion_tokens: 4 } } },
    ],
    toolResults: { 'notes/tidy': { success: true, result: 'tidied' } },
    expect:      {
      status:       'completed',
      iterations:   2,
      invocations:  [],
      toolMessages: ['Error: "notes/tidy" needs the user\'s approval and this device can\'t ask for it.'],
    },
  },
  {
    name:       'irreversible tool runs once the user approves',
    api:        'anthropic-messages',
    providerId: 'anthropic',
    model:      'claude-sonnet-5-5',
    messages:   [{ role: 'user', content: 'Email Bob that I am late' }],
    tools:      [sendEmail],
    approvals:  { 'email/send': true },
    replies:    [
      {
        status: 200,
        body:   {
          stop_reason: 'tool_use',
          content:     [{ type: 'tool_use', id: 't1', name: 'email__send', input: { to: 'bob@example.com', body: 'Running late' } }],
          usage:       { input_tokens: 40, output_tokens: 12 },
        },
      },
      { status: 200, body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sent.' }], usage: { input_tokens: 60, output_tokens: 2 } } },
    ],
    toolResults: { 'email/send': { success: true, result: 'sent' } },
    expect:      {
      status:       'completed',
      finalText:    'Sent.',
      iterations:   2,
      approvals:    [{ name: 'email/send', args: { to: 'bob@example.com', body: 'Running late' } }],
      invocations:  [{ name: 'email/send', args: { to: 'bob@example.com', body: 'Running late' } }],
      toolMessages: ['sent'],
    },
  },
  {
    name:       'a relayed write with requiresApproval asks first; declined',
    api:        'openai-chat',
    providerId: 'openai',
    model:      'gpt-5',
    messages:   [{ role: 'user', content: 'Save a note on my Mac' }],
    tools:      [relayedWrite],
    approvals:  { 'fs/write_file': false },
    replies:    [
      {
        status: 200,
        body:   { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'w1', function: { name: 'fs__write_file', arguments: '{"path":"/notes.md","text":"hi"}' } }] } }], usage: { prompt_tokens: 20, completion_tokens: 9 } },
      },
      { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'Not saved.' } }], usage: { prompt_tokens: 30, completion_tokens: 3 } } },
    ],
    toolResults: { 'fs/write_file': { success: true, result: 'written' } },
    expect:      {
      status:       'completed',
      iterations:   2,
      approvals:    [{ name: 'fs/write_file', args: { path: '/notes.md', text: 'hi' } }],
      invocations:  [],
      toolMessages: ['Error: the user did not approve "fs/write_file".'],
    },
  },
  {
    name:       'anthropic: a tool call cut off at max_tokens is not run',
    api:        'anthropic-messages',
    providerId: 'anthropic',
    model:      'claude-sonnet-5-5',
    messages:   [{ role: 'user', content: 'Write my notes file' }],
    tools:      [writeFile],
    budget:     { maxOutputTokens: 64 },
    replies:    [
      {
        status: 200,
        body:   {
          stop_reason: 'max_tokens',
          content:     [
            { type: 'text', text: 'Writing it.' },
            { type: 'tool_use', id: 'tw', name: 'fs__write_file', input: { path: '/notes.md' } },
          ],
          usage: { input_tokens: 30, output_tokens: 64 },
        },
      },
      { status: 200, body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Too long; I will split it.' }], usage: { input_tokens: 90, output_tokens: 9 } } },
    ],
    toolResults: { 'fs/write_file': { success: true, result: 'written' } },
    expect:      {
      status:          'completed',
      iterations:      2,
      invocations:     [],
      toolMessages:    [CUT_OFF],
      requestMessages: [
        [{ role: 'user', content: [{ type: 'text', text: 'Write my notes file' }] }],
        [
          { role: 'user', content: [{ type: 'text', text: 'Write my notes file' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Writing it.' }, { type: 'tool_use', id: 'tw', name: 'fs__write_file', input: { path: '/notes.md' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tw', content: CUT_OFF, is_error: true }] },
        ],
      ],
    },
  },
  {
    name:       'openai: a tool call cut off at length is not run',
    api:        'openai-chat',
    providerId: 'openai',
    model:      'gpt-5',
    messages:   [{ role: 'user', content: 'Write my notes file' }],
    tools:      [writeFile],
    replies:    [
      {
        status: 200,
        body:   {
          choices: [{ finish_reason: 'length', message: { content: null, tool_calls: [{ id: 'cw', function: { name: 'fs__write_file', arguments: '{"path":"/notes.md","text":"he' } }] } }],
          usage:   { prompt_tokens: 30, completion_tokens: 64 },
        },
      },
      { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'Too long.' } }], usage: { prompt_tokens: 90, completion_tokens: 3 } } },
    ],
    toolResults: { 'fs/write_file': { success: true, result: 'written' } },
    expect:      {
      status:       'completed',
      iterations:   2,
      invocations:  [],
      toolMessages: [CUT_OFF],
    },
  },
  {
    name:       'anthropic: parallel tool calls share one tool_result message',
    api:        'anthropic-messages',
    providerId: 'anthropic',
    model:      'claude-sonnet-5-5',
    messages:   [{ role: 'user', content: 'Weather in Portland and Seattle?' }],
    tools:      [webSearch],
    replies:    [
      {
        status: 200,
        body:   {
          stop_reason: 'tool_use',
          content:     [
            { type: 'tool_use', id: 'toolu_p1', name: 'web__web_search', input: { query: 'Portland' } },
            { type: 'tool_use', id: 'toolu_p2', name: 'web__web_search', input: { query: 'Seattle' } },
          ],
          usage: { input_tokens: 50, output_tokens: 20 },
        },
      },
      { status: 200, body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Both rainy.' }], usage: { input_tokens: 120, output_tokens: 4 } } },
    ],
    toolResults: { 'web/web_search': searchResult },
    expect:      {
      status:          'completed',
      iterations:      2,
      invocations:     [{ name: 'web/web_search', args: { query: 'Portland' } }, { name: 'web/web_search', args: { query: 'Seattle' } }],
      events:          ['model_request', 'usage', 'tool_call:toolu_p1', 'tool_result:toolu_p1:ok', 'tool_call:toolu_p2', 'tool_result:toolu_p2:ok', 'model_request', 'usage', 'text:Both rainy.', 'done:completed'],
      requestMessages: [
        [{ role: 'user', content: [{ type: 'text', text: 'Weather in Portland and Seattle?' }] }],
        [
          { role: 'user', content: [{ type: 'text', text: 'Weather in Portland and Seattle?' }] },
          {
            role:    'assistant',
            content: [
              { type: 'tool_use', id: 'toolu_p1', name: 'web__web_search', input: { query: 'Portland' } },
              { type: 'tool_use', id: 'toolu_p2', name: 'web__web_search', input: { query: 'Seattle' } },
            ],
          },
          {
            role:    'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_p1', content: '{"hits":[{"title":"Portland weather","snippet":"Rain, 12°C"}]}' },
              { type: 'tool_result', tool_use_id: 'toolu_p2', content: '{"hits":[{"title":"Portland weather","snippet":"Rain, 12°C"}]}' },
            ],
          },
        ],
      ],
    },
  },
  {
    name:       'cross-provider replay: an OpenAI transcript continues on Anthropic',
    api:        'anthropic-messages',
    providerId: 'anthropic',
    model:      'claude-sonnet-5-5',
    messages:   [
      { role: 'user', content: 'Weather in Portland?' },
      {
        role:    'assistant',
        content: [
          { type: 'tool_use', id: 'call_0', name: 'web__web_search', input: { query: 'Portland weather' } },
          { type: 'tool_use', id: 'call_1', name: 'web__web_search', input: '{"query": broken' },
        ],
      },
      { role: 'tool', tool_call_id: 'call_0', name: 'web__web_search', content: '{"hits":[]}' },
      { role: 'tool', tool_call_id: 'call_1', name: 'web__web_search', content: 'Error: Arguments for "web__web_search" must be a JSON object.', metadata: { isError: true } },
      { role: 'assistant', content: 'No results.' },
      { role: 'user', content: 'Try tomorrow?' },
    ],
    tools:   [webSearch],
    replies: [
      { status: 200, body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Still nothing.' }], usage: { input_tokens: 80, output_tokens: 3 } } },
    ],
    toolResults: {},
    expect:      {
      status:          'completed',
      iterations:      1,
      requestMessages: [[
        { role: 'user', content: [{ type: 'text', text: 'Weather in Portland?' }] },
        {
          role:    'assistant',
          content: [
            { type: 'tool_use', id: 'call_0', name: 'web__web_search', input: { query: 'Portland weather' } },
            { type: 'tool_use', id: 'call_1', name: 'web__web_search', input: {} },
          ],
        },
        {
          role:    'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_0', content: '{"hits":[]}' },
            { type: 'tool_result', tool_use_id: 'call_1', content: 'Error: Arguments for "web__web_search" must be a JSON object.', is_error: true },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'No results.' }] },
        { role: 'user', content: [{ type: 'text', text: 'Try tomorrow?' }] },
      ]],
    },
  },
  {
    name:       'cross-provider replay: an Anthropic transcript continues on OpenAI',
    api:        'openai-chat',
    providerId: 'openai',
    model:      'gpt-5',
    messages:   [
      { role: 'user', content: 'Weather?' },
      { role: 'assistant', content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'toolu_9', name: 'web__web_search', input: { query: 'Portland' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: '{"hits":[]}' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'nothing found' }, { type: 'text', text: 'No results.' }] },
      { role: 'user', content: 'Try tomorrow?' },
    ],
    tools:   [webSearch],
    replies: [
      { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'Still nothing.' } }], usage: { prompt_tokens: 70, completion_tokens: 3 } } },
    ],
    toolResults: {},
    expect:      {
      status:          'completed',
      iterations:      1,
      requestMessages: [[
        { role: 'user', content: 'Weather?' },
        { role: 'assistant', content: 'Checking.', tool_calls: [{ id: 'toolu_9', type: 'function', function: { name: 'web__web_search', arguments: '{"query":"Portland"}' } }] },
        { role: 'tool', tool_call_id: 'toolu_9', content: '{"hits":[]}' },
        { role: 'assistant', content: 'No results.' },
        { role: 'user', content: 'Try tomorrow?' },
      ]],
    },
  },
  {
    name:       'openai-compatible: missing, repeated and unsafe tool ids are made unique',
    api:        'openai-chat',
    providerId: 'together',
    model:      'kimi-k2',
    adapterOptions: { baseUrl: 'https://api.together.xyz/v1' },
    messages:   [{ role: 'user', content: 'Search a to e' }],
    tools:      [webSearch],
    replies:    [
      {
        status: 200,
        body:   {
          choices: [{
            finish_reason: 'tool_calls',
            message:       {
              content:    null,
              tool_calls: [
                { function: { name: 'web__web_search', arguments: '{"query":"a"}' } },
                { function: { name: 'web__web_search', arguments: '{"query":"b"}' } },
              ],
            },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        },
      },
      {
        status: 200,
        body:   {
          choices: [{
            finish_reason: 'tool_calls',
            message:       {
              content:    null,
              tool_calls: [
                { function: { name: 'web__web_search', arguments: '{"query":"c"}' } },
                { id: 'functions.web__web_search:1', function: { name: 'web__web_search', arguments: '{"query":"d"}' } },
                { id: 'functions.web__web_search:1', function: { name: 'web__web_search', arguments: '{"query":"e"}' } },
              ],
            },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        },
      },
      { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'Done.' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } } },
    ],
    toolResults: { 'web/web_search': searchResult },
    expect:      {
      status:      'completed',
      iterations:  3,
      toolCallIds: ['call_0', 'call_1', 'call_2_0', 'functions_web__web_search_1', 'call_2_2'],
      invocations: ['a', 'b', 'c', 'd', 'e'].map(q => ({ name: 'web/web_search', args: { query: q } })),
    },
  },
  {
    name:       'tool errors and exceptions that contain a key are redacted',
    api:        'anthropic-messages',
    providerId: 'anthropic',
    model:      'claude-sonnet-5-5',
    messages:   [{ role: 'user', content: 'Look it up' }],
    tools:      [webSearch, readNote],
    replies:    [
      {
        status: 200,
        body:   {
          stop_reason: 'tool_use',
          content:     [
            { type: 'tool_use', id: 'r1', name: 'web__web_search', input: { query: 'x' } },
            { type: 'tool_use', id: 'r2', name: 'notes__read', input: { id: 'n' } },
          ],
          usage: { input_tokens: 10, output_tokens: 10 },
        },
      },
      { status: 200, body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Both failed.' }], usage: { input_tokens: 10, output_tokens: 3 } } },
    ],
    toolResults: {
      'web/web_search': { success: false, error: { code: 'upstream', message: 'Upstream rejected key sk-test-SECRET-should-never-leak' } },
      'notes/read':     { throws: 'connect failed with token sk-test-SECRET-should-never-leak' },
    },
    expect: {
      status:       'completed',
      iterations:   2,
      invocations:  [{ name: 'web/web_search', args: { query: 'x' } }, { name: 'notes/read', args: { id: 'n' } }],
      toolMessages: ['Error (upstream): Upstream rejected key [redacted]', 'Error (tool_exception): connect failed with token [redacted]'],
    },
  },
  {
    name:       'openrouter: a 200 reply with an error body is a provider error',
    api:        'openai-chat',
    providerId: 'openrouter',
    model:      'anthropic/claude-sonnet-5-5',
    adapterOptions: { baseUrl: 'https://openrouter.ai/api/v1' },
    messages:   [{ role: 'user', content: 'Hi' }],
    tools:      [],
    replies:    [
      { status: 200, body: { error: { code: 429, message: 'Rate limit exceeded for sk-test-SECRET-should-never-leak' } } },
    ],
    toolResults: {},
    expect:      {
      status:     'provider_error',
      iterations: 1,
      error:      { code: 'rate_limited', status: 429, message: 'Provider returned 429: Rate limit exceeded for [redacted]' },
      roles:      ['user'],
    },
  },
  {
    name:       'anthropic streaming: text deltas and a tool call split across chunks',
    api:        'anthropic-messages',
    providerId: 'anthropic',
    model:      'claude-sonnet-5-5',
    stream:     true,
    messages:   [{ role: 'user', content: 'Weather in Portland?' }],
    tools:      [webSearch],
    replies:    [
      {
        status: 200,
        chunks: anthropicStream('claude-sonnet-5-5', [
          { type: 'text', deltas: ['Let me ', 'check.'] },
          { type: 'tool_use', id: 'toolu_s1', name: 'web__web_search', json: ['{"query":', ' "Portland"}'] },
        ], 'tool_use', { input: 30, cacheRead: 5, output: 18 }),
      },
      {
        status: 200,
        chunks: anthropicStream('claude-sonnet-5-5', [{ type: 'text', deltas: ['Rainy', ', 12°C.'] }], 'end_turn', { input: 50, output: 4 }),
      },
    ],
    toolResults: { 'web/web_search': searchResult },
    expect:      {
      status:      'completed',
      finalText:   'Rainy, 12°C.',
      iterations:  2,
      usage:       { inputTokens: 85, outputTokens: 22, cachedTokens: 5, cacheWriteTokens: 0 },
      invocations: [{ name: 'web/web_search', args: { query: 'Portland' } }],
      events:      [
        'model_request', 'text_delta:Let me ', 'text_delta:check.', 'usage', 'text:Let me check.', 'tool_call:toolu_s1', 'tool_result:toolu_s1:ok',
        'model_request', 'text_delta:Rainy', 'text_delta:, 12°C.', 'usage', 'text:Rainy, 12°C.', 'done:completed',
      ],
      requestBodies: [{ stream: true, max_tokens: 4096 }, { stream: true }],
    },
  },
  {
    name:       'openai streaming: CRLF events, tool-call argument deltas, usage chunk',
    api:        'openai-chat',
    providerId: 'openai',
    model:      'gpt-5',
    adapterOptions: { maxTokensField: 'max_completion_tokens' },
    stream:     true,
    messages:   [{ role: 'user', content: 'Weather in Portland?' }],
    tools:      [webSearch],
    budget:     { maxOutputTokens: 500 },
    replies:    [
      {
        status: 200,
        chunks: chunked(sse([
          { model: 'gpt-5', choices: [{ index: 0, delta: { role: 'assistant', content: 'Check' } }] },
          { choices: [{ index: 0, delta: { content: 'ing.' } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_s', type: 'function', function: { name: 'web__web_search', arguments: '' } }] } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Portland"}' } }] } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          { choices: [], usage: { prompt_tokens: 40, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 8 } } },
          '[DONE]',
        ], '\r\n'), 5),
      },
      {
        status: 200,
        chunks: chunked(sse([
          { model: 'gpt-5', choices: [{ index: 0, delta: { content: 'Rainy.' }, finish_reason: 'stop' }] },
          { choices: [], usage: { prompt_tokens: 70, completion_tokens: 2 } },
          '[DONE]',
        ], '\r\n'), 9),
      },
    ],
    toolResults: { 'web/web_search': searchResult },
    expect:      {
      status:        'completed',
      finalText:     'Rainy.',
      iterations:    2,
      usage:         { inputTokens: 110, outputTokens: 14, cachedTokens: 8, cacheWriteTokens: 0 },
      invocations:   [{ name: 'web/web_search', args: { query: 'Portland' } }],
      toolCallIds:   ['call_s'],
      events:        ['model_request', 'text_delta:Check', 'text_delta:ing.', 'usage', 'text:Checking.', 'tool_call:call_s', 'tool_result:call_s:ok', 'model_request', 'text_delta:Rainy.', 'usage', 'text:Rainy.', 'done:completed'],
      requestBodies: [{ stream: true, stream_options: { include_usage: true }, max_completion_tokens: 500 }, { stream: true }],
    },
  },
  {
    name:       'openai streaming: a stream that stops mid tool call is not run',
    api:        'openai-chat',
    providerId: 'openai',
    model:      'gpt-5',
    stream:     true,
    messages:   [{ role: 'user', content: 'Write my notes file' }],
    tools:      [writeFile],
    replies:    [
      {
        status: 200,
        chunks: chunked(sse([
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_w', type: 'function', function: { name: 'fs__write_file', arguments: '{"path":"/notes.md","text":"hel' } }] } }] },
        ]), 11),
      },
      { status: 200, chunks: [sse([{ choices: [{ index: 0, delta: { content: 'Cut off.' }, finish_reason: 'stop' }] }, '[DONE]'])] },
    ],
    toolResults: { 'fs/write_file': { success: true, result: 'written' } },
    expect:      {
      status:       'completed',
      iterations:   2,
      invocations:  [],
      toolMessages: [CUT_OFF],
    },
  },
  {
    name:       'anthropic streaming: an error event becomes a provider error',
    api:        'anthropic-messages',
    providerId: 'anthropic',
    model:      'claude-sonnet-5-5',
    stream:     true,
    messages:   [{ role: 'user', content: 'Hi' }],
    tools:      [],
    replies:    [
      {
        status: 200,
        chunks: chunked(sse([
          ['message_start', { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 5, output_tokens: 1 } } }],
          ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
        ]), 13),
      },
    ],
    toolResults: {},
    expect:      {
      status:     'provider_error',
      iterations: 1,
      error:      { code: 'provider_unavailable', status: 529, message: 'Provider returned 529: Overloaded' },
      roles:      ['user'],
    },
  },
  {
    name:       'anthropic streaming: a 401 error body is redacted',
    api:        'anthropic-messages',
    providerId: 'anthropic',
    model:      'claude-sonnet-5-5',
    stream:     true,
    messages:   [{ role: 'user', content: 'Hi' }],
    tools:      [],
    replies:    [
      { status: 401, chunks: chunked(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key sk-test-SECRET-should-never-leak' } }), 10) },
    ],
    toolResults: {},
    expect:      {
      status:     'provider_error',
      iterations: 1,
      error:      { code: 'auth', status: 401, message: 'Provider returned 401: invalid x-api-key [redacted]' },
      roles:      ['user'],
    },
  },
];
