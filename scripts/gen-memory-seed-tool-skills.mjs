#!/usr/bin/env node
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSE in the repository root.
// Source-available, not open source. Do not remove this notice, bypass license-key
// checks, run this software as a hosted service for others, or resell it.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = path.join(root, 'resources/memory-seed/skills');
const sourceDir = path.join(root, 'pkg/sulla-desktop/agent/tools');
const start = '<!-- tools:generated:start -->';
const end = '<!-- tools:generated:end -->';
const wanted = new Set(readdirSync(skillsDir).filter(f => f.startsWith('sulla-tool-') && f.endsWith('.md')).map(f => f.slice(11, -3)));

function matchingClose(text, open) {
  let depth = 0, quote = null, escape = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  throw new Error(`Unclosed object at ${open}`);
}
function literal(text, key, from = 0) {
  const m = new RegExp(`\\b${key}\\s*:\\s*(['\"])`).exec(text.slice(from));
  if (!m) return undefined;
  const begin = from + m.index + m[0].length, quote = m[1];
  let value = '', escaped = false;
  for (let i = begin; i < text.length; i++) {
    const c = text[i];
    if (escaped) { value += c; escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === quote) return value;
    value += c;
  }
  return undefined;
}
function firstSentence(text) { return text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\\s+/)[0]; }
function valueFor(name, spec) {
  const enumMatch = spec.match(/enum\s*:\s*\[([^]]*)\]/s);
  if (enumMatch) { const first = enumMatch[1].match(/['"]([^'"]+)['"]/); if (first) return first[1]; }
  const type = literal(spec, 'type') || 'string';
  if (type === 'number') return 1;
  if (type === 'boolean') return true;
  if (type === 'array') return [];
  if (type === 'object') return {};
  if (type === 'any') return null;
  if (/path/i.test(name)) return '<absolutePath>';
  if (/sql/i.test(name)) return '<sql>';
  if (/url/i.test(name)) return 'https://example.com';
  if (/email/i.test(name)) return 'user@example.com';
  if (/message|body|text|content|prompt|yaml|command|query|title|name|slug|repo|owner|channel|key|value|field|token|reason/i.test(name)) return `<${name}>`;
  return `<${name}>`;
}
function parseSchema(block) {
  const at = block.search(/\bschemaDef\s*:/);
  if (at < 0) return [];
  const open = block.indexOf('{', at); if (open < 0) return [];
  const body = block.slice(open + 1, matchingClose(block, open));
  const params = [];
  let depth = 0, quote = null, esc = false, lineStart = 0;
  for (let i = 0; i <= body.length; i++) {
    const c = body[i] || '\n';
    if (quote) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++; else if (c === '}') depth--;
    if (depth === 0 && c === '\n') {
      const line = body.slice(lineStart, i);
      const m = line.match(/^\s*([A-Za-z_][\w]*)\s*:\s*\{(.*)\}\s*,?\s*$/s);
      if (m) params.push({ name: m[1], spec: m[2], required: !/\boptional\s*:\s*true\b/.test(m[2]) });
      lineStart = i + 1;
    }
  }
  return params;
}
function parseManifest(file, folder) {
  const text = readFileSync(file, 'utf8'), tools = [];
  for (const hit of text.matchAll(/\{\s*\n?\s*name\s*:/g)) {
    const open = hit.index, close = matchingClose(text, open), block = text.slice(open, close + 1);
    const name = literal(block, 'name'), category = literal(block, 'category'), description = literal(block, 'description');
    if (name && category && description && wanted.has(category)) tools.push({ name, category, description: firstSentence(description), params: parseSchema(block), folder });
  }
  return tools;
}
const tools = [];
for (const folder of readdirSync(sourceDir, { withFileTypes: true })) {
  if (!folder.isDirectory()) continue;
  const file = path.join(sourceDir, folder.name, 'manifests.ts');
  try { tools.push(...parseManifest(file, folder.name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const byCategory = new Map();
for (const tool of tools) { if (!byCategory.has(tool.category)) byCategory.set(tool.category, []); byCategory.get(tool.category).push(tool); }
function render(category) {
  const rows = [...(byCategory.get(category) || [])].sort((a, b) => a.name.localeCompare(b.name));
  return [start, ...rows.map(tool => {
    const args = Object.fromEntries(tool.params.filter(p => p.required).map(p => [p.name, valueFor(p.name, p.spec)]));
    const json = JSON.stringify(args);
    const req = tool.params.filter(p => p.required).map(p => p.name).join(', ') || 'none';
    const opt = tool.params.filter(p => !p.required).map(p => p.name).join(', ') || 'none';
    return `- \`sulla ${category}/${tool.name} ${json}\`: ${tool.description} Required: ${req}. Optional: ${opt}.`;
  }), end].join('\n');
}
let changed = false;
for (const category of wanted) {
  const file = path.join(skillsDir, `sulla-tool-${category}.md`), old = readFileSync(file, 'utf8');
  const generated = render(category);
  const next = old.includes(start) && old.includes(end)
    ? old.replace(new RegExp(`${start}[\\s\\S]*?${end}`), generated)
    : old.replace(/\*\*Tools:\*\*[\s\S]*?(?=\n\*\*Do:\*\*|\n\*\*Don't:\*\*)/, `**Tools:**\n\n${generated}`);
  if (next !== old) { changed = true; if (!process.argv.includes('--check')) writeFileSync(file, next); }
}
if (process.argv.includes('--check') && changed) process.exitCode = 1;
console.log(`${changed ? (process.argv.includes('--check') ? 'Would update' : 'Updated') : 'No changes'} ${wanted.size} skill files.`);
