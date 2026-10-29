// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildToolIndex,
  createAdapter,
  createSseParser,
  formatToolResult,
  needsApproval,
  parseToolId,
  providerError,
  redactSecrets,
  requiresApprovalFor,
  resolveToolCall,
  runTurn,
  sendJson,
  toolId,
  validateParams,
  wireToolName,
} from '../dist/index.js';

const search = {
  name:        'web/web_search',
  description: 'Search',
  inputSchema: { type: 'object', properties: { query: { type: 'string' }, safe: { type: 'boolean' }, mode: { type: 'string', enum: ['fast', 'deep'] }, filter: {} }, required: ['query'] },
  sideEffect:  'read',
};
const index = buildToolIndex([search]);

test('wire names are provider-safe', () => {
  assert.equal(wireToolName('web/web_search'), 'web__web_search');
  assert.equal(wireToolName('a.b c'), 'a_b_c');
  assert.equal(wireToolName('x'.repeat(80)).length, 64);
});

test('resolver accepts prefixed, cased, wrapped and exec shapes but never widens the allowlist', () => {
  for (const name of ['web/web_search', 'web__web_search', 'functions.web__web_search', 'tools:web__web_search', 'web__web_search:0', 'web.web_search']) {
    const r = resolveToolCall({ id: '1', name, args: { query: 'q' } }, index);
    assert.equal(r.kind, 'dispatch', name);
  }
  const wrapped = resolveToolCall({ id: '1', name: 'web__web_search', args: { params: { query: 'q' } } }, index);
  assert.deepEqual(wrapped.args, { query: 'q' });
  const nested = resolveToolCall({ id: '1', name: 'exec', args: { tool_id: 'web/web_search', params: '{"query":"q"}' } }, index);
  assert.deepEqual(nested.args, { query: 'q' });
  assert.equal(resolveToolCall({ id: '1', name: 'exec', args: { tool_id: 'fs/exec', params: {} } }, index).kind, 'error');
  assert.equal(resolveToolCall({ id: '1', name: 'fs__exec', args: {} }, index).kind, 'error');
  assert.match(resolveToolCall({ id: '1', name: 'web__web_search', args: 'not json' }, index).message, /JSON object/);
});

test('validateParams coerces slips and explains failures', () => {
  assert.deepEqual(validateParams(search.inputSchema, { query: 'q', safe: 'true', mode: 'DEEP', filter: '{"a":1}' }), {
    ok: true, params: { query: 'q', safe: true, mode: 'deep', filter: { a: 1 } },
  });
  assert.deepEqual(validateParams(search.inputSchema, { query: 'q', safe: null }), { ok: true, params: { query: 'q' } });
  const bad = validateParams(search.inputSchema, { mode: 'slow' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /"mode" must be one of fast, deep/);
  assert.match(bad.error, /"query" is required/);
});

test('tool results are truncated with a hint', () => {
  const out = formatToolResult('x'.repeat(20), 10);
  assert.ok(out.startsWith('xxxxxxxxxx… [truncated 10 of 20 chars'));
});

test('key-like strings are redacted from provider errors', () => {
  assert.equal(redactSecrets('bad key sk-ant-api03-abcDEF123_xyz. retry'), 'bad key [redacted]. retry');
  assert.equal(redactSecrets('key AIza' + 'A'.repeat(30)), 'key [redacted]');
});

test('tool ids are category/name', () => {
  assert.equal(toolId('github', 'github_create_pr'), 'github/github_create_pr');
  assert.deepEqual(parseToolId('web/web_search'), { category: 'web', name: 'web_search' });
  assert.equal(parseToolId('web_search'), null);
});

test('approval fails closed and only ever adds gates', () => {
  assert.equal(needsApproval({ sideEffect: 'read' }), false);
  assert.equal(needsApproval({ sideEffect: 'write' }), false);
  assert.equal(needsApproval({ sideEffect: 'irreversible' }), true);
  assert.equal(needsApproval({}), true);
  assert.equal(needsApproval({ sideEffect: 'delete' }), true);
  assert.equal(needsApproval({ sideEffect: 'write', requiresApproval: true }), true);
  assert.equal(needsApproval({ sideEffect: 'irreversible', requiresApproval: false }), true);
  assert.equal(requiresApprovalFor({ sideEffect: 'read', relayed: true }), false);
  assert.equal(requiresApprovalFor({ sideEffect: 'write', relayed: true }), true);
  assert.equal(requiresApprovalFor({ sideEffect: 'write' }), false);
  assert.equal(requiresApprovalFor({ sideEffect: 'irreversible' }), true);
});

test('buildToolIndex refuses tools that share a wire name', () => {
  assert.throws(() => buildToolIndex([{ ...search }, { ...search, name: 'web__web_search' }]), /both map to the name "web__web_search"/);
  const long = 'x'.repeat(70);
  assert.throws(() => buildToolIndex([{ ...search, name: `${ long }a` }, { ...search, name: `${ long }b` }]), /both map/);
  assert.doesNotThrow(() => buildToolIndex([search, search]));
});

test('provider errors: 408 retries, a failing body read is a network error, 200+error fails', async() => {
  assert.equal(providerError('x', 408, 'bad_request').retryable, true);
  assert.equal(providerError('x', 400, 'bad_request').retryable, false);
  const req = { url: 'u', method: 'POST', headers: {} };
  await assert.rejects(
    sendJson(req, async() => ({ ok: true, status: 200, text: async() => { throw new Error('socket reset, key sk-live-abcdef123456') } })),
    e => e.code === 'network' && !e.message.includes('sk-live') && e.message.includes('[redacted]'),
  );
  await assert.rejects(
    sendJson(req, async() => ({ ok: true, status: 200, text: async() => '{"error":{"message":"upstream down","code":502}}' })),
    e => e.code === 'provider_unavailable' && e.status === 502 && e.retryable,
  );
});

test('openai adapter: max_completion_tokens capability flag', () => {
  const input = { model: 'o4', messages: [{ role: 'user', content: 'hi' }], tools: [], maxOutputTokens: 10 };
  const plain = JSON.parse(createAdapter('openai-chat').buildRequest(input).body);
  assert.equal(plain.max_tokens, 10);
  const reasoning = JSON.parse(createAdapter('openai-chat', { maxTokensField: 'max_completion_tokens' }).buildRequest(input).body);
  assert.equal(reasoning.max_completion_tokens, 10);
  assert.equal('max_tokens' in reasoning, false);
});

test('usage means the same thing on every adapter', () => {
  const a = createAdapter('anthropic-messages').parseResponse({ content: [], usage: { input_tokens: 10, cache_read_input_tokens: 70, cache_creation_input_tokens: 20, output_tokens: 5 } });
  assert.deepEqual(a.usage, { inputTokens: 100, outputTokens: 5, cachedTokens: 70, cacheWriteTokens: 20 });
  const o = createAdapter('openai-chat').parseResponse({ choices: [{ message: {} }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 70 } } });
  assert.deepEqual(o.usage, { inputTokens: 100, outputTokens: 5, cachedTokens: 70, cacheWriteTokens: 0 });
});

test('finishReason keeps length and content_filter even with tool calls', () => {
  const tool = { type: 'tool_use', id: 't', name: 'x', input: {} };
  const anthropic = createAdapter('anthropic-messages');
  assert.equal(anthropic.parseResponse({ stop_reason: 'max_tokens', content: [tool] }).finishReason, 'length');
  assert.equal(anthropic.parseResponse({ stop_reason: 'refusal', content: [tool] }).finishReason, 'content_filter');
  assert.equal(anthropic.parseResponse({ stop_reason: 'tool_use', content: [tool] }).finishReason, 'tool_calls');
  const openai = createAdapter('openai-chat');
  const call = { id: 'c', function: { name: 'x', arguments: '{}' } };
  assert.equal(openai.parseResponse({ choices: [{ finish_reason: 'length', message: { tool_calls: [call] } }] }).finishReason, 'length');
  // Some compatible servers say "stop" next to a finished tool call.
  assert.equal(openai.parseResponse({ choices: [{ finish_reason: 'stop', message: { tool_calls: [call] } }] }).finishReason, 'tool_calls');
});

test('SSE parser handles split lines, CRLF, comments and a missing final blank line', () => {
  const events = [];
  const p = createSseParser(ev => events.push(ev));
  for (const c of [': keep-alive\r', '\nevent: a\r\nda', 'ta: 1\r', '\ndata: 2\r\n', '\r\ndata: tail']) p.push(c);
  p.end();
  assert.deepEqual(events, [{ event: 'a', data: '1\n2' }, { data: 'tail' }]);
});

function scriptedHost(replies, opts = {}) {
  let i = 0;
  const invoked = [];
  return {
    invoked,
    host: {
      keyBroker: {
        async fetch() {
          if (opts.onFetch) opts.onFetch(i);
          const body = JSON.stringify(replies[i++]);
          return { ok: true, status: 200, text: async() => body };
        },
      },
      toolHost: {
        async invoke(call) {
          invoked.push(call.name);
          if (opts.throwOn === call.name) throw new Error('boom');
          if (opts.onInvoke) opts.onInvoke(call);
          return { success: true, result: 'ok' };
        },
      },
    },
  };
}

const twoCalls = {
  stop_reason: 'tool_use',
  content:     [
    { type: 'tool_use', id: 'a', name: 'web__web_search', input: { query: 'a' } },
    { type: 'tool_use', id: 'b', name: 'web__web_search', input: { query: 'b' } },
  ],
  usage: { input_tokens: 1, output_tokens: 1 },
};
const done = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } };
const base = { runId: 'r', providerId: 'anthropic', model: 'm', adapter: createAdapter('anthropic-messages'), messages: [{ role: 'user', content: 'go' }], tools: [search] };

test('an aborted signal stops before any model call', async() => {
  const { host } = scriptedHost([done]);
  const r = await runTurn({ ...base, host, signal: { aborted: true } });
  assert.equal(r.status, 'aborted');
  assert.equal(r.iterations, 0);
});

test('abort during tools answers the remaining tool_use blocks', async() => {
  const signal = { aborted: false };
  const { host, invoked } = scriptedHost([twoCalls, done], { onInvoke: () => { signal.aborted = true } });
  const r = await runTurn({ ...base, host, signal });
  assert.equal(r.status, 'aborted');
  assert.deepEqual(invoked, ['web/web_search']);
  assert.deepEqual(r.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['a', 'b']);
  assert.match(r.messages[3].content, /Not run/);
});

test('irreversible tools are refused when the host cannot ask a human', async() => {
  const send = { name: 'email/send', description: 'Send', sideEffect: 'irreversible' };
  const { host, invoked } = scriptedHost([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 's', name: 'email__send', input: {} }], usage: {} },
    done,
  ]);
  const r = await runTurn({ ...base, tools: [send], host });
  assert.equal(r.status, 'completed');
  assert.deepEqual(invoked, []);
  assert.match(r.messages[2].content, /needs the user's approval/);
});

test('a throwing event listener does not break the turn', async() => {
  const { host, invoked } = scriptedHost([twoCalls, done]);
  const r = await runTurn({ ...base, host, onEvent: () => { throw new Error('listener bug') } });
  assert.equal(r.status, 'completed');
  assert.deepEqual(invoked, ['web/web_search', 'web/web_search']);
});

test('a failing checkpoint stops the turn cleanly after the tool that ran', async() => {
  const { host, invoked } = scriptedHost([twoCalls, done]);
  let saves = 0;
  host.checkpoint = { async save() { if (++saves === 2) throw new Error('disk full, token sk-live-abcdef123456') } };
  const r = await runTurn({ ...base, host });
  assert.equal(r.status, 'checkpoint_failed');
  assert.deepEqual(invoked, ['web/web_search']);
  assert.deepEqual(r.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['a', 'b']);
  assert.match(r.messages[3].content, /Not run: the turn stopped \(checkpoint_failed\)/);
  assert.equal(r.error.code, 'checkpoint_failed');
  assert.ok(!r.error.message.includes('sk-live'));
});

test('a checkpoint failure before any tool runs none of them', async() => {
  const { host, invoked } = scriptedHost([twoCalls, done]);
  host.checkpoint = { async save() { throw new Error('nope') } };
  const r = await runTurn({ ...base, host });
  assert.equal(r.status, 'checkpoint_failed');
  assert.deepEqual(invoked, []);
  assert.equal(r.messages.filter(m => m.role === 'tool').length, 2);
});

test('abort stops waiting on a pending approval', async() => {
  const send = { name: 'email/send', description: 'Send', sideEffect: 'irreversible' };
  const { host, invoked } = scriptedHost([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 's', name: 'email__send', input: {} }], usage: {} },
    done,
  ]);
  const controller = new AbortController();
  let seenSignal;
  host.toolHost.approve = (call, spec, ctx) => {
    seenSignal = ctx.signal;
    setTimeout(() => controller.abort(), 5);
    return new Promise(() => {}); // the user never answers
  };
  const r = await runTurn({ ...base, tools: [send], host, signal: controller.signal });
  assert.equal(r.status, 'aborted');
  assert.equal(seenSignal, controller.signal);
  assert.deepEqual(invoked, []);
  assert.match(r.messages[2].content, /Not run: the turn stopped \(aborted\)/);
});

test('a non-provider adapter failure is redacted', async() => {
  const adapter = { ...createAdapter('anthropic-messages'), complete: async() => { throw new Error('bad header sk-live-abcdef123456') } };
  const { host } = scriptedHost([]);
  const r = await runTurn({ ...base, adapter, host });
  assert.equal(r.status, 'provider_error');
  assert.equal(r.error.message, 'bad header [redacted]');
});

test('stream: false uses fetch even when the broker can stream', async() => {
  const { host } = scriptedHost([done]);
  host.keyBroker.stream = async() => { throw new Error('should not stream') };
  const r = await runTurn({ ...base, host, stream: false });
  assert.equal(r.status, 'completed');
});

test('a throwing tool host becomes a tool error, not a crash', async() => {
  const { host } = scriptedHost([twoCalls, done], { throwOn: 'web/web_search' });
  const r = await runTurn({ ...base, host });
  assert.equal(r.status, 'completed');
  assert.match(r.messages[2].content, /tool_exception.*boom/);
});

// tsconfig also builds with lib ES2022 and no @types, so global fetch,
// TextEncoder, timers and Node globals fail to compile.
test('the source imports nothing platform-specific', () => {
  const src = fileURLToPath(new URL('../src', import.meta.url));
  const files = [];
  const walk = dir => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(src);
  assert.ok(files.length > 5);
  const banned = [
    /from\s+['"]node:/, /from\s+['"](fs|path|crypto|os|http|https|net|child_process|buffer|stream|url|util)['"]/,
    /from\s+['"](react-native|electron|cloudflare:)/, /\brequire\(/, /\bprocess\./, /\bBuffer\./, /\bglobalThis\b/, /\bconsole\./, /^\s*(export\s+)?(abstract\s+)?class\s/m, /=\s*class\b/,
  ];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const re of banned) assert.ok(!re.test(text), `${ f } matches ${ re }`);
  }
});
