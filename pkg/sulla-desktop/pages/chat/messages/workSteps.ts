// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ThinkingMessage, ToolMessage } from '../models/Message';

/**
 * A work log (thoughts and tool calls) as readable steps. The raw entries
 * stay available; this only decides what a person reads first. Plain code,
 * no model: commands are summarised from their own text.
 */
export type WorkStep =
  | { kind: 'think'; key: string; text: string }
  | { kind: 'run'; key: string; title: string; detail: string; raw: string; status?: ToolMessage['status']; tool?: ToolMessage }
  | { kind: 'note'; key: string; text: string };

/** Status lines that only announce the next entry ("Running a shell command"). */
const FILLER = /^(running a shell command|running a command|preparing your turn…?|booting isolated environment…?|tools connected[^]*|session started[^]*|thinking…?|writing a file|editing files|using [\w./-]+)$/i;
const THOUGHT = /^💭\s*/;
const COMMAND = /^\$\s+/;

export function workSteps(messages: readonly (ThinkingMessage | ToolMessage)[]): WorkStep[] {
  const steps: WorkStep[] = [];
  for (const message of messages) {
    if (message.kind === 'tool') {
      steps.push({
        kind:   'run',
        key:    message.id,
        title:  message.tool,
        detail: message.desc,
        raw:    message.input ?? '',
        status: message.status,
        tool:   message,
      });
      continue;
    }
    message.thoughts.forEach((thought, index) => {
      const text = thought.trim();
      const key = `${ message.id }:${ index }`;
      if (!text || FILLER.test(text)) return;
      if (COMMAND.test(text)) {
        const command = summariseCommand(text.replace(COMMAND, ''));
        steps.push({ kind: 'run', key, title: command.title, detail: command.detail, raw: text });
      } else if (THOUGHT.test(text)) {
        steps.push({ kind: 'think', key, text: text.replace(THOUGHT, '') });
      } else {
        steps.push({ kind: 'note', key, text });
      }
    });
  }
  return steps;
}

/**
 * `sulla github/merge_pr '{"repo":"x","pull_number":4334,"sha":"aefaf0d…"}'`
 * reads as title "github merge_pr", detail "x #4334 · aefaf0d". Anything else
 * keeps the command's first words as the title.
 */
export function summariseCommand(command: string): { title: string; detail: string } {
  const sulla = /^sulla\s+([\w-]+)\/([\w-]+)\s*(?:'([^]*?)'?)?\s*(?:2>&1.*)?$/.exec(command);
  if (sulla) {
    const args = parseArgs(sulla[3]);
    const pr = args.pull_number ?? args.number ?? args.pr;
    const parts = [
      typeof args.repo === 'string' ? `${ args.repo }${ pr ? ` #${ pr }` : '' }` : pr ? `#${ pr }` : '',
      typeof args.sha === 'string' ? args.sha.slice(0, 7) : '',
      typeof args.query === 'string' ? `"${ args.query.slice(0, 60) }"` : '',
      typeof args.path === 'string' ? args.path : '',
    ].filter(Boolean);
    return { title: `${ sulla[1] } ${ sulla[2] }`, detail: parts.join(' · ') };
  }
  const words = command.replace(/\s+/g, ' ').trim();
  const program = words.split(' ')[0] ?? '';
  return { title: program.split('/').pop() || 'command', detail: words.length > 90 ? `${ words.slice(0, 89) }…` : words };
}

function parseArgs(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
  } catch {
    // Truncated by the activity line: pull out the simple fields we show.
    const pick = (name: string) => new RegExp(`"${ name }"\\s*:\\s*("([^"]*)"|(\\d+))`).exec(text);
    const out: Record<string, unknown> = {};
    for (const name of ['repo', 'pull_number', 'number', 'sha', 'query', 'path']) {
      const match = pick(name);
      if (match) out[name] = match[2] ?? Number(match[3]);
    }
    return out;
  }
}

/**
 * The one-line title. Live: what it is doing now. Finished: the summary Sulla
 * recorded, else the commands it ran, else its first thought.
 */
export function workTitle(steps: readonly WorkStep[], completed: boolean, summary?: string): { lead: string; rest: string } {
  const runs = steps.filter((step): step is Extract<WorkStep, { kind: 'run' }> => step.kind === 'run');
  if (!completed) {
    const latest = steps[steps.length - 1];
    if (!latest) return { lead: 'Thinking', rest: '' };
    if (latest.kind === 'run') return { lead: latest.title, rest: latest.detail };
    return { lead: 'Thinking', rest: latest.text };
  }
  if (summary?.trim()) return { lead: summary.trim(), rest: runs.length ? uniqueTitles(runs) : '' };
  if (runs.length) return { lead: `Ran ${ runs.length } step${ runs.length === 1 ? '' : 's' }`, rest: uniqueTitles(runs) };
  const first = steps.find(step => step.kind !== 'run');
  return { lead: 'Thought it through', rest: first?.text ?? '' };
}

function uniqueTitles(runs: readonly { title: string }[]): string {
  const names = [...new Set(runs.map(run => run.title.split(' ').pop() ?? run.title))];
  return names.length > 4 ? `${ names.slice(0, 4).join(', ') }, +${ names.length - 4 }` : names.join(', ');
}
