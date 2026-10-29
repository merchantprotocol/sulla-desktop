// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Tool-call normalization shared by every host.
 *
 * Merges the rules Cloud's AgentDO uses (sulla-workers
 * `src/services/mcp/tool-calls.ts`): accept whatever shape the model
 * produced (native name, "functions.x" prefixes, kebab/snake slips, an
 * `exec` meta call with nested, stringified or flattened params, a
 * `{ params: {…} }` wrapper), coerce obvious type slips, and return an
 * error the model can act on instead of a stack trace. Resolution only
 * ever matches the allowed tools passed in, so it can't widen an agent's
 * allowlist.
 */

import type { JsonSchema, ToolCall, ToolSpec } from './types.js';

/** Tool results beyond this are cut so small-context models keep working. */
export const MAX_TOOL_RESULT_CHARS = 12_000;

const WIRE_NAME_MAX = 64;

/**
 * Provider-safe function name. OpenAI and Anthropic accept
 * `^[a-zA-Z0-9_-]{1,64}$`, so `web/web_search` goes out as `web__web_search`.
 */
export function wireToolName(name: string): string {
  return name.replace(/\//g, '__').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, WIRE_NAME_MAX);
}

/** Make a tool schema acceptable to strict tool-calling templates. */
export function sanitizeSchema(schema: JsonSchema | undefined): Record<string, unknown> {
  const s = schema ?? {};
  const props = s.properties ?? {};
  const cleaned: Record<string, unknown> = {};
  for (const k of Object.keys(props)) cleaned[k] = sanitizeProp(props[k]);
  const out: Record<string, unknown> = { type: 'object', properties: cleaned };
  const required = (s.required ?? []).filter(r => r in props);
  if (required.length) out.required = required;
  return out;
}

function sanitizeProp(p: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Untyped props confuse some templates: declare them as strings of JSON;
  // validateParams parses them back.
  out.type = p.type ?? 'string';
  if (p.description) out.description = p.type ? p.description : `${ p.description } (JSON)`;
  if (p.enum) out.enum = p.enum;
  if (p.type === 'array') out.items = p.items ? sanitizeProp(p.items) : { type: 'string' };
  if (p.type === 'object' && p.properties) {
    const inner: Record<string, unknown> = {};
    for (const k of Object.keys(p.properties)) inner[k] = sanitizeProp(p.properties[k]);
    out.properties = inner;
    if (p.required?.length) out.required = p.required;
  }
  return out;
}

export type ResolvedCall =
  | { kind: 'dispatch'; spec: ToolSpec; args: Record<string, unknown> }
  | { kind: 'error'; message: string };

export interface ToolIndex {
  byName: Map<string, ToolSpec>;
}

export function buildToolIndex(tools: ToolSpec[]): ToolIndex {
  const byName = new Map<string, ToolSpec>();
  for (const spec of tools) {
    byName.set(spec.name, spec);
    byName.set(wireToolName(spec.name), spec);
  }
  return { byName };
}

function cleanName(name: string): string {
  return name
    .trim()
    .replace(/^(functions|function|tools|tool)[.:]/i, '')
    .replace(/:\d+$/, '')
    .trim();
}

function findSpec(name: string, index: ToolIndex): ToolSpec | null {
  const candidates = [
    name,
    name.replace(/-/g, '_').toLowerCase(),
    name.replace(/_/g, '-').toLowerCase(),
    name.replace(/\./g, '/'),
    wireToolName(name),
  ];
  for (const c of candidates) {
    const hit = index.byName.get(c);
    if (hit) return hit;
  }
  return null;
}

function suggest(name: string, index: ToolIndex): string[] {
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const names = Array.from(new Set(Array.from(index.byName.values()).map(s => s.name)));
  return names
    .map(n => ({ n, score: words.filter(w => n.toLowerCase().includes(w)).length }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(x => x.n);
}

export function asObject(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string' && v.trim().startsWith('{')) {
    try {
      const o = JSON.parse(v);
      if (o && typeof o === 'object' && !Array.isArray(o)) return o;
    } catch { /* not JSON */ }
  }
  return null;
}

/** Parse provider-supplied arguments. Empty means `{}`; bad JSON stays a string. */
export function parseToolArguments(raw: unknown): unknown {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'string') return raw;
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function unknownTool(name: string, index: ToolIndex): ResolvedCall {
  const s = suggest(name, index);
  return {
    kind:    'error',
    message: `There is no tool named "${ name }".` +
      (s.length ? ` Did you mean: ${ s.join(', ') }?` : ' Only the listed tools can be called.'),
  };
}

const EXEC_ID_KEYS = ['tool_id', 'toolId', 'id', 'tool', 'endpoint', 'name'];
const EXEC_SKIP_KEYS = ['tool_id', 'toolId', 'tool', 'endpoint', 'params', 'arguments', 'args'];

export function resolveToolCall(call: ToolCall, index: ToolIndex): ResolvedCall {
  const name = cleanName(call.name || '');
  const args = asObject(call.args);
  if (!args) {
    return { kind: 'error', message: `Arguments for "${ name }" must be a JSON object.` };
  }

  // `exec` meta call, unless the agent really has a tool named exec.
  if (name === 'exec' && !index.byName.has('exec')) {
    const rawId = EXEC_ID_KEYS.map(k => args[k]).find(v => typeof v === 'string' && v.trim()) as string | undefined;
    if (!rawId) {
      return { kind: 'error', message: 'exec needs "tool_id" (the tool to run) and "params".' };
    }
    const spec = findSpec(cleanName(rawId), index);
    if (!spec) return unknownTool(rawId, index);

    let params = asObject(args.params) ?? asObject(args.arguments) ?? asObject(args.args);
    if (!params) {
      // Flattened: { tool_id, query: "…" }: everything but the id keys.
      params = {};
      for (const k of Object.keys(args)) {
        if (EXEC_SKIP_KEYS.indexOf(k) >= 0) continue;
        if ((k === 'id' || k === 'name') && args[k] === rawId) continue;
        params[k] = args[k];
      }
    }
    return { kind: 'dispatch', spec, args: params };
  }

  const spec = findSpec(name, index);
  if (!spec) return unknownTool(name, index);

  // Some models wrap native-tool arguments in { params: {…} }.
  let params = args;
  const schemaProps = spec.inputSchema?.properties ?? {};
  const wrapped = asObject(args.params);
  if (wrapped && Object.keys(args).length === 1 && !('params' in schemaProps)) params = wrapped;
  return { kind: 'dispatch', spec, args: params };
}

export type Validation =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; error: string };

export function validateParams(schema: JsonSchema | undefined, input: Record<string, unknown>): Validation {
  const props = schema?.properties ?? {};
  const required = schema?.required ?? [];
  const out: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const k of Object.keys(input ?? {})) {
    const raw = input[k];
    const p = props[k];
    // Models often send null / "" for optional args they mean to omit.
    if ((raw === null || raw === '') && required.indexOf(k) < 0) continue;
    if (!p) {
      out[k] = raw;
      continue;
    }
    const coerced = coerce(p, raw);
    if (coerced.ok) out[k] = coerced.value;
    else problems.push(`"${ k }" ${ coerced.error }`);
  }

  for (const r of required) {
    const v = out[r];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
      problems.push(`"${ r }" is required${ props[r]?.description ? ` (${ props[r].description })` : '' }`);
    }
  }

  if (problems.length) {
    const expected = Object.keys(props)
      .map(k => `${ k }${ required.indexOf(k) >= 0 ? '' : '?' }: ${ props[k].type ?? 'any' }`)
      .join(', ');
    return { ok: false, error: `Invalid arguments: ${ problems.join('; ') }. Expected { ${ expected } }.` };
  }
  return { ok: true, params: out };
}

function coerce(p: JsonSchema, v: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (p.type) {
  case 'integer':
  case 'number': {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (Number.isNaN(n)) return { ok: false, error: `must be a ${ p.type }` };
    return { ok: true, value: p.type === 'integer' ? Math.trunc(n) : n };
  }
  case 'boolean': {
    if (typeof v === 'boolean') return { ok: true, value: v };
    if (v === 'true' || v === 1 || v === '1') return { ok: true, value: true };
    if (v === 'false' || v === 0 || v === '0') return { ok: true, value: false };
    return { ok: false, error: 'must be true or false' };
  }
  case 'object': {
    const o = asObject(v);
    return o ? { ok: true, value: o } : { ok: false, error: 'must be an object' };
  }
  case 'array': {
    if (Array.isArray(v)) return { ok: true, value: v };
    if (typeof v === 'string' && v.trim().startsWith('[')) {
      try {
        const a = JSON.parse(v);
        if (Array.isArray(a)) return { ok: true, value: a };
      } catch { /* fall through */ }
    }
    return { ok: false, error: 'must be an array' };
  }
  case 'string': {
    if (typeof v === 'string') {
      if (p.enum && p.enum.indexOf(v) < 0) {
        const hit = p.enum.find(e => e.toLowerCase() === v.toLowerCase());
        if (hit) return { ok: true, value: hit };
        return { ok: false, error: `must be one of ${ p.enum.join(', ') }` };
      }
      return { ok: true, value: v };
    }
    if (typeof v === 'number' || typeof v === 'boolean') return { ok: true, value: String(v) };
    return { ok: false, error: 'must be a string' };
  }
  default: {
    // Untyped (declared to the model as a JSON string): parse it back.
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          return { ok: true, value: JSON.parse(t) };
        } catch { /* keep string */ }
      }
    }
    return { ok: true, value: v };
  }
  }
}

export function formatToolResult(result: unknown, max = MAX_TOOL_RESULT_CHARS): string {
  let s: string;
  try {
    s = typeof result === 'string' ? result : JSON.stringify(result ?? null);
  } catch {
    s = String(result);
  }
  if (s.length <= max) return s;
  return `${ s.slice(0, max) }… [truncated ${ s.length - max } of ${ s.length } chars; narrow the request (filters, limit) to see the rest]`;
}
