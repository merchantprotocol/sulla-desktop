// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Runtime-neutral golden runner. It takes the built core as an argument and
 * uses only language built-ins, so Node, Workers (miniflare) and Hermes
 * all run the exact same checks.
 */

/** A fake key the broker "injects"; it must never reach the transcript. */
export const FAKE_KEY = 'sk-test-SECRET-should-never-leak';

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

async function runFixture(core, fx) {
  const requests = [];
  const invocations = [];
  const approvals = [];
  const checkpoints = [];
  let reply = 0;
  let clock = 0;

  const keyBroker = {
    async fetch(providerId, request) {
      if (providerId !== fx.providerId) throw new Error(`wrong provider ${ providerId }`);
      requests.push({ url: request.url, headers: request.headers, body: request.body ? JSON.parse(request.body) : undefined });
      // What a real broker does: add the credential outside the core.
      const sent = { ...request, headers: { ...request.headers, authorization: `Bearer ${ FAKE_KEY }` } };
      if (!sent.headers.authorization) throw new Error('unreachable');
      const r = fx.replies[reply++];
      if (!r) throw new Error('no recorded reply left');
      const text = JSON.stringify(r.body);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async() => text };
    },
  };
  const toolHost = {
    async invoke(call) {
      invocations.push({ name: call.name, args: call.args });
      return fx.toolResults[call.name] || { success: false, error: { code: 'not_found', message: 'no fixture result' } };
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
    adapter:    core.createAdapter(fx.api, fx.baseUrl ? { baseUrl: fx.baseUrl } : {}),
    system:     fx.system,
    messages:   fx.messages,
    tools:      fx.tools,
    budget:     fx.budget,
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
  if (e.invocations) check(problems, 'invocations', invocations, e.invocations);
  if (e.approvals) check(problems, 'approvals', approvals, e.approvals);
  if (e.roles) check(problems, 'roles', result.messages.map(m => m.role), e.roles);
  if (e.requests) check(problems, 'requests', requests, e.requests);
  if (e.requestUrls) check(problems, 'requestUrls', requests.map(r => r.url), e.requestUrls);
  if (e.toolMessages) check(problems, 'toolMessages', result.messages.filter(m => m.role === 'tool').map(m => m.content), e.toolMessages);
  if (e.error) check(problems, 'error', result.error, e.error);
  check(problems, 'replies consumed', reply, fx.replies.length);
  if (!checkpoints.length && result.iterations > 0 && result.status !== 'provider_error') problems.push('no checkpoint saved');

  // Every tool_use must have exactly one tool result.
  const used = [];
  const answered = [];
  for (const m of result.messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === 'tool_use') used.push(b.id);
    }
    if (m.role === 'tool') answered.push(m.tool_call_id);
  }
  check(problems, 'tool_use/tool_result pairing', answered, used);

  const leakScan = JSON.stringify(result) + JSON.stringify(requests);
  if (leakScan.indexOf(FAKE_KEY) >= 0) problems.push('API key leaked into the transcript, result or request');

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
