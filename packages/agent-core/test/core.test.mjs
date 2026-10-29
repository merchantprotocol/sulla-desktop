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
  formatToolResult,
  redactSecrets,
  resolveToolCall,
  runTurn,
  validateParams,
  wireToolName,
} from '../dist/index.js';

const search = {
  name:        'web/web_search',
  description: 'Search',
  inputSchema: { type: 'object', properties: { query: { type: 'string' }, safe: { type: 'boolean' }, mode: { type: 'string', enum: ['fast', 'deep'] }, filter: {} }, required: ['query'] },
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
    /from\s+['"](react-native|electron|cloudflare:)/, /\brequire\(/, /\bprocess\./, /\bBuffer\./, /\bglobalThis\b/, /\bconsole\./,
  ];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const re of banned) assert.ok(!re.test(text), `${ f } matches ${ re }`);
  }
});
