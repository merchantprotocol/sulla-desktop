// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Runtime-neutral golden runner. It takes the built core as an argument and
 * uses only language built-ins, so Node, Workers (miniflare) and Hermes
 * all run the exact same checks.
 */

/**
 * A fake key. Fixtures plant it where a real key can show up (provider error
 * bodies, tool errors, tool exceptions); it must never reach the transcript,
 * the result, the events or a request the core builds.
 */
export const FAKE_KEY = 'sk-test-SECRET-should-never-leak';

const AUTH_HEADERS = ['authorization', 'x-api-key', 'api-key', 'x-goog-api-key'];

function same(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(b, ka[i]) || !same(a[ka[i]], b[ka[i]])) return false;
  }
  return true;
}

function check(problems, label, actual, expected) {
  if (!same(actual, expected)) problems.push(`${ label }: expected ${ JSON.stringify(expected) }, got ${ JSON.stringify(actual) }`);
}

/** Compact event log: `type`, plus the text of text/text_delta events. */
function eventLog(events) {
  return events.map((ev) => {
    if (ev.type === 'text_delta' || ev.type === 'text') return `${ ev.type }:${ ev.text }`;
    if (ev.type === 'tool_call') return `tool_call:${ ev.call.id }`;
    if (ev.type === 'tool_result') return `tool_result:${ ev.id }:${ ev.success ? 'ok' : 'error' }`;
    if (ev.type === 'done') return `done:${ ev.status }`;
    return ev.type;
  });
}

async function runFixture(core, fx) {
  const requests = [];
  const invocations = [];
  const approvals = [];
  const checkpoints = [];
  const events = [];
  let reply = 0;
  let clock = 0;

  const record = (providerId, request) => {
    if (providerId !== fx.providerId) throw new Error(`wrong provider ${ providerId }`);
    requests.push({ url: request.url, headers: request.headers, body: request.body ? JSON.parse(request.body) : undefined });
    const r = fx.replies[reply++];
    if (!r) throw new Error('no recorded reply left');
    return r;
  };
  const keyBroker = {
    async fetch(providerId, request) {
      const r = record(providerId, request);
      const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async() => text };
    },
  };
  if (fx.stream) {
    keyBroker.stream = async(providerId, request, onChunk) => {
      const r = record(providerId, request);
      for (const chunk of r.chunks) onChunk(chunk);
      return { ok: r.status >= 200 && r.status < 300, status: r.status };
    };
  }
  const toolHost = {
    async invoke(call) {
      invocations.push({ name: call.name, args: call.args });
      const result = fx.toolResults[call.name];
      if (result && result.throws) throw new Error(result.throws);
      return result || { success: false, error: { code: 'not_found', message: 'no fixture result' } };
    },
  };
  if (fx.approvals) {
    toolHost.approve = async(call) => {
      approvals.push({ name: call.name, args: call.args });
      return !!fx.approvals[call.name];
    };
  }

  const result = await core.runTurn({
    runId:      `golden-${ fx.name }`,
    providerId: fx.providerId,
    model:      fx.model,
    adapter:    core.createAdapter(fx.api, fx.adapterOptions || {}),
    system:     fx.system,
    messages:   fx.messages,
    tools:      fx.tools,
    budget:     fx.budget,
    onEvent:    ev => events.push(ev),
    host:       {
      keyBroker,
      toolHost,
      clock:      { now: () => (clock += 5) },
      checkpoint: { save: async(state) => { checkpoints.push(state.iteration) } },
    },
  });

  const e = fx.expect;
  const problems = [];
  check(problems, 'status', result.status, e.status);
  check(problems, 'iterations', result.iterations, e.iterations);
  if ('finalText' in e) check(problems, 'finalText', result.finalText, e.finalText);
  if (e.usage) check(problems, 'usage', result.usage, e.usage);
  check(problems, 'invocations', invocations, e.invocations || []);
  if (e.approvals) check(problems, 'approvals', approvals, e.approvals);
  if (e.roles) check(problems, 'roles', result.messages.map(m => m.role), e.roles);
  if (e.requests) check(problems, 'requests', requests, e.requests);
  if (e.requestUrls) check(problems, 'requestUrls', requests.map(r => r.url), e.requestUrls);
  if (e.requestMessages) check(problems, 'requestMessages', requests.map(r => r.body && r.body.messages), e.requestMessages);
  if (e.requestBodies) {
    // Only the listed body fields are compared.
    check(problems, 'request count', requests.length, e.requestBodies.length);
    e.requestBodies.forEach((fields, i) => {
      for (const k of Object.keys(fields)) check(problems, `request ${ i + 1 } body.${ k }`, requests[i] && requests[i].body && requests[i].body[k], fields[k]);
    });
  }
  if (e.toolMessages) check(problems, 'toolMessages', result.messages.filter(m => m.role === 'tool').map(m => m.content), e.toolMessages);
  if (e.toolCallIds) check(problems, 'toolCallIds', result.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id), e.toolCallIds);
  if (e.error) check(problems, 'error', result.error, e.error);
  if (e.events) check(problems, 'events', eventLog(events), e.events);
  check(problems, 'replies consumed', reply, fx.replies.length);
  if (!checkpoints.length && result.iterations > 0 && result.status !== 'provider_error') problems.push('no checkpoint saved');

  // The turn always ends with exactly one done event carrying its status.
  const done = events.filter(ev => ev.type === 'done');
  if (done.length !== 1 || events[events.length - 1] !== done[0] || done[0].status !== result.status) problems.push('missing or misplaced done event');
  // Deltas, when streamed, add up to the reply text.
  if (fx.stream && result.status === 'completed') {
    const deltas = events.filter(ev => ev.type === 'text_delta').map(ev => ev.text).join('');
    const texts = events.filter(ev => ev.type === 'text').map(ev => ev.text).join('');
    check(problems, 'text_delta total', deltas, texts);
  }

  // Every tool_use must have exactly one tool result.
  const used = [];
  const answered = [];
  for (const m of result.messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === 'tool_use') used.push(b.id);
    }
    if (m.role === 'tool') answered.push(m.tool_call_id);
    // Transcripts stored in Anthropic's shape carry results as user blocks.
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === 'tool_result') answered.push(b.tool_use_id);
    }
  }
  check(problems, 'tool_use/tool_result pairing', answered, used);
  if (new Set(used).size !== used.length) problems.push(`tool_use ids repeat: ${ JSON.stringify(used) }`);

  // The core never builds a credential into a request: the broker adds it.
  for (const r of requests) {
    for (const h of Object.keys(r.headers || {})) {
      if (AUTH_HEADERS.indexOf(h.toLowerCase()) >= 0) problems.push(`core set credential header ${ h }`);
    }
  }
  const leakScan = JSON.stringify(result) + JSON.stringify(requests) + JSON.stringify(events);
  if (leakScan.indexOf(FAKE_KEY) >= 0) problems.push('API key leaked into the transcript, result, events or a request');

  // The input transcript must not be mutated.
  check(problems, 'input messages untouched', fx.messages.length, result.messages.length - result.newMessages.length);

  return { name: fx.name, ok: problems.length === 0, problems };
}

export async function runGolden(core, fixtures) {
  const results = [];
  for (const fx of fixtures) {
    try {
      results.push(await runFixture(core, fx));
    } catch (err) {
      results.push({ name: fx.name, ok: false, problems: [`threw: ${ err && err.stack ? err.stack : String(err) }`] });
    }
  }
  return results;
}
