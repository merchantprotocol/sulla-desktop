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
  | { kind: 'run'; key: string; title: string; short?: string; detail: string; raw: string; status?: ToolMessage['status']; tool?: ToolMessage }
  | { kind: 'note'; key: string; text: string };

/** Status lines that only announce the next entry ("Running a shell command"). */
const FILLER = /^(running a shell command|running a command|preparing your turn(?:…|\.\.\.)?|booting isolated environment(?:…|\.\.\.)?|tools connected[^]*|session started[^]*|thinking(?:…|\.\.\.)?|writing a file|editing files|using [\w./-]+)$/i;
const THOUGHT = /^💭\s*/;
const COMMAND = /^\$\s+/;

function workSteps(messages: readonly (ThinkingMessage | ToolMessage)[]): WorkStep[] {
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
        steps.push({ kind: 'run', key, title: command.title, short: command.short, detail: command.detail, raw: text });
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
/** Sulla's tool namespaces and the actions people recognise; anything else reads with spaces for underscores. */
const NAMESPACE: Record<string, string> = { github: 'GitHub', agents: 'Agents', meta: 'Sulla', slack: 'Slack', files: 'Files', memory: 'Memory', calendar: 'Calendar', gmail: 'Gmail' };
const ACTIONS: Record<string, string> = {
  get_pr:           'read PR',
  merge_pr:         'merge PR',
  create_pr:        'open PR',
  list_prs:         'list PRs',
  update_pr:        'update PR',
  close_pr:         'close PR',
  check_runs:       'CI checks',
  get_check_runs:   'CI checks',
  list_check_runs:  'CI checks',
  ci_logs:          'CI logs',
  get_ci_logs:      'CI logs',
  rerun_checks:     'rerun CI',
  get_pr_comments:  'read PR comments',
  create_review:    'post review',
  post_review:      'post review',
  add_comment:      'comment',
  get_file:         'read file',
  search_code:      'search code',
  send_job_message: 'message agent',
  spawn_agent:      'start agent',
  check_agent_jobs: 'check agents',
  report_progress:  'report progress',
  return_result:    'return result',
  stop_job:         'stop agent',
  git_push:         'push',
  git_fetch:        'fetch',
  exechost:         'run on host',
  browse_tools:     'find tools',
};
function toolAction(namespace: string, tool: string): string {
  return ACTIONS[tool] ?? tool.replace(/[_-]+/g, ' ');
}

/**
 * Agents' own words, with Sulla's tool names said plainly:
 * "sulla github/git_push and git_fetch fail" → "GitHub push and fetch fail".
 */
function plainToolNames(text: string): string {
  return text
    .replace(/\b(?:sulla\s+)?([A-Za-z]+)\/([a-z][\w-]*)/g, (all, ns: string, tool: string) => NAMESPACE[ns.toLowerCase()] ? `${ NAMESPACE[ns.toLowerCase()] } ${ toolAction(ns, tool) }` : all)
    .replace(/\b[a-z]+(?:_[a-z]+)+\b/g, word => ACTIONS[word] ?? word)
    // GitHub's review verdicts as words: CHANGES_REQUESTED → "changes requested".
    .replace(/\b(CHANGES_REQUESTED|APPROVED|COMMENTED|DISMISSED)\b/g, word => word.toLowerCase().replace(/_/g, ' '));
}

/** Wrappers that only limit or schedule the real command: `timeout 60`, `nice -n 5`, `nohup`, `env X=1`, `time`, `sudo`. */
const WRAPPER = /^(?:timeout(?:\s+-[\w=-]+)*\s+\d+(?:\.\d+)?[smhd]?|nice(?:\s+-n)?(?:\s+-?\d+)?|nohup|time|sudo|env(?:\s+\w+=\S*)*)\s+/;

function unwrap(command: string): string {
  let out = command.trim();
  for (let previous = ''; previous !== out;) { previous = out; out = out.replace(WRAPPER, '') }
  return out;
}

function summariseCommand(raw: string): { title: string; short?: string; detail: string } {
  const command = unwrap(raw);
  const sulla = /^sulla\s+([\w-]+)\/([\w-]+)\s*(?:'([^]*?)'?)?\s*(?:2>&1.*)?$/.exec(command);
  if (sulla) {
    const action = toolAction(sulla[1], sulla[2]);
    return { title: `${ NAMESPACE[sulla[1]] ?? sulla[1] } · ${ action }`, short: action, detail: argsDetail(sulla[3]) };
  }
  const words = command.replace(/\s+/g, ' ').trim();
  const title = commandName(words);
  const shown = plainPaths(words);
  // A Sulla tool inside a loop: "GitHub · read PR" titles it; "read PR" names it in a list;
  // its arguments, not the loop's raw shell and JSON, are the detail.
  const short = title.includes(' · ') ? title.split(' · ').pop() : undefined;
  const inner = short ? /sulla\s+[\w-]+\/[\w-]+\s*'([^']*)'/.exec(command) : null;
  const detail = inner ? `${ argsDetail(inner[1]) || 'repeated' } · in a loop` : shown.length > 90 ? `${ shown.slice(0, 89) }…` : shown;
  return { title, ...(short ? { short } : {}), detail };
}

/** A Sulla tool call's arguments as a short line: "repo #4352 · ee7ae6f". */
function argsDetail(json: string | undefined): string {
  const args = parseArgs(json);
  const pr = args.pull_number ?? args.number ?? args.pr;
  return [
    typeof args.repo === 'string' ? `${ args.repo }${ pr ? ` #${ pr }` : '' }` : pr ? `#${ pr }` : '',
    typeof args.sha === 'string' ? args.sha.slice(0, 7) : '',
    typeof args.query === 'string' ? `"${ args.query.slice(0, 60) }"` : '',
    typeof args.path === 'string' ? args.path : '',
  ].filter(Boolean).join(' · ');
}

/**
 * Sulla's own folders read by their last part, and long ids shortened:
 * `cd /mnt/data/sulla/runtime/conversations/2a2adf72…c75/work && ls` → `cd …/work && ls`.
 */
function plainPaths(text: string): string {
  return text
    .replace(/(?:\/mnt\/data\/sulla|\/private\/tmp|\/Users\/[^/\s]+)(?:\/[^\s'"`;|&)]+)*/g, (path) => {
      const last = path.split('/').pop() ?? '';
      return /^[0-9a-f]{24,}$/.test(last) ? '…/chat folder' : `…/${ last }`;
    })
    .replace(/\b[0-9a-f]{24,}\b/g, id => id.slice(0, 7));
}

/** Steps that only set the stage (`cd x &&`, `echo ---;`, loop keywords), never the point of a command. */
const SETUP = /^(cd|echo|printf|export|set|true|sleep|source|\.|clear|:|seq)$/;
const KEYWORDS = /^(for|while|until|if|then|else|elif|do|done|fi|case|esac|in|time|sudo|env|nohup|exec)$/;
/** Tools whose first argument says what they do (`git status`, `gh pr`). */
const SUBCOMMANDED = /^(git|gh|npm|pnpm|yarn|npx|docker|kubectl|wrangler|uv|cargo|go|brew|psql|sulla|codex|claude)$/;

/**
 * The name of what a shell command actually runs: the first segment that is
 * not setup or a loop keyword, as `program subcommand` for tools like git.
 * `cd /repo && git status --short` → "git status"; `for p in 1 2; do gh pr view $p; done` → "gh pr".
 */
function commandName(command: string): string {
  for (const segment of command.split(/&&|\|\||;|\||\n|\$\(|`/)) {
    const words = segment.trim().split(' ').filter(word => word && !/^\w+=/.test(word));
    if (/^(for|case|select)$/.test(words[0] ?? '')) continue; // a loop header names a variable, not a program
    while (words.length && KEYWORDS.test(words[0])) words.shift();
    const rest = unwrap(words.join(' '));
    const tool = /^sulla\s+([\w-]+)\/([\w-]+)/.exec(rest);
    if (tool) return `${ NAMESPACE[tool[1]] ?? tool[1] } · ${ toolAction(tool[1], tool[2]) }`;
    words.splice(0, words.length, ...rest.split(' ').filter(Boolean));
    const program = (words[0] ?? '').split('/').pop() ?? '';
    if (!program || SETUP.test(program) || !/^[\w.-]+$/.test(program)) continue;
    const next = words[1];
    if (SUBCOMMANDED.test(program) && next && /^[a-z][\w-]*$/.test(next)) return `${ program } ${ next }`;
    const script = /^python\d?$|^node$|^bash$|^sh$/.test(program) && next && /\.\w+$/.test(next) ? next.split('/').pop() : '';
    return script ? `${ program } ${ script }` : program;
  }
  return 'shell';
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
function workTitle(steps: readonly WorkStep[], completed: boolean, summary?: string): { lead: string; rest: string } {
  const runs = steps.filter((step): step is Extract<WorkStep, { kind: 'run' }> => step.kind === 'run');
  if (!completed) {
    const latest = steps[steps.length - 1];
    if (!latest) return { lead: 'Thinking', rest: '' };
    if (latest.kind === 'run') return { lead: latest.title, rest: latest.detail };
    return { lead: 'Thinking', rest: latest.text };
  }
  // The saved summary is the log's first line: a real sentence, or only a
  // status placeholder ("Thinking…") or a command, which say nothing.
  const said = summary?.trim().replace(THOUGHT, '');
  if (said && !FILLER.test(said) && !COMMAND.test(said)) return { lead: said, rest: runs.length ? uniqueTitles(runs) : '' };
  if (runs.length) return { lead: `Ran ${ runs.length } step${ runs.length === 1 ? '' : 's' }`, rest: uniqueTitles(runs) };
  const first = steps.find(step => step.kind !== 'run');
  return { lead: 'Thought it through', rest: first?.text ?? '' };
}

/** The step names for a title: `merge_pr` for Sulla tools, `git status` for shell commands. */
function uniqueTitles(runs: readonly { title: string; short?: string }[]): string {
  const names = [...new Set(runs.map(run => run.short ?? run.title))];
  return names.length > 4 ? `${ names.slice(0, 4).join(', ') }, +${ names.length - 4 }` : names.join(', ');
}

/** Work steps: reading a block's tool calls and thoughts as steps, titles and plain names. */
export class WorkSteps {
  static readonly workSteps = workSteps;
  static readonly plainToolNames = plainToolNames;
  static readonly summariseCommand = summariseCommand;
  static readonly workTitle = workTitle;
}
