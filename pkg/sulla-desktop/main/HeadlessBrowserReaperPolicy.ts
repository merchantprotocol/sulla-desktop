// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const HEADLESS_BROWSER_IDLE_MS = 5 * 60_000;

export function parseProcessCpuTime(value: string): number {
  const [dayPrefix, clock] = value.includes('-') ? value.split('-', 2) : ['0', value];
  const parts = clock.split(':');
  if (parts.length < 2 || parts.length > 3) return 0;
  const [hours, minutes, seconds] = parts.length === 3 ? parts : ['0', parts[0], parts[1]];
  if (![dayPrefix, hours, minutes, seconds].every(part => /^\d+(?:\.\d+)?$/.test(part))) return 0;
  return (((Number(dayPrefix) * 24 + Number(hours)) * 60 + Number(minutes)) * 60) + Number(seconds);
}

export interface HeadlessProcessCandidate {
  command: string;
  args: string;
}

export function isProtectedProcess(candidate: HeadlessProcessCandidate): boolean {
  return /(?:^|[/\\\s])(?:sulla|electron)(?:\s|$)/i.test(`${ candidate.command } ${ candidate.args }`)
    || /(?:Sulla|Electron)\.app/i.test(candidate.args);
}

export function isHeadlessBrowser(candidate: HeadlessProcessCandidate): boolean {
  if (isProtectedProcess(candidate)) return false;
  const executable = candidate.command.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  const shellExecutable = executable === 'chrome-headless-shell' || executable === 'chrome-headless-shell.exe'
    || /(?:^|[/\\\s])chrome-headless-shell(?:\.exe)?(?:\s|$)/i.test(candidate.args);
  if (shellExecutable) return true;
  const chromiumExecutable = ['chrome', 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'].includes(executable)
    || /(?:^|[/\\\s])(?:chrome|chromium|chromium-browser|google-chrome(?:-stable)?)(?:\s|$)/i.test(candidate.args)
    || /Google Chrome(?:\.app)?\/Contents\/MacOS\/Google Chrome/i.test(candidate.args);
  return chromiumExecutable && /(?:^|\s)--headless(?:=|\s|$)/.test(candidate.args);
}

/**
 * The Mac is the human's machine, not Sulla's sandbox: on the host only reap
 * browsers Sulla started (descended from the Desktop process, or launched from
 * a Sulla-owned path). Inside the Sulla runtime VM every headless browser is ours.
 */
export function isSullaOwnedHostBrowser(candidate: HeadlessProcessCandidate, descendsFromSulla: boolean): boolean {
  if (descendsFromSulla) return true;
  return /(?:[/\\]sulla[/\\]|Sulla Desktop|sulla-desktop)/i.test(`${ candidate.command } ${ candidate.args }`);
}

export interface ReapDecisionInput {
  candidate: boolean;
  /** False when the browser belongs to someone else (e.g. the human's own tools on the Mac host). */
  owned?: boolean;
  protectedProcess: boolean;
  orphaned: boolean;
  idleForMs: number;
}

export interface ReapDecision {
  reap: boolean;
  reason?: 'idle' | 'orphaned-idle';
}

/** Pure decision function: the caller measures tree CPU idle time and ownership. */
export function decideHeadlessProcessReap(input: ReapDecisionInput): ReapDecision {
  if (!input.candidate || input.owned === false || input.protectedProcess || input.idleForMs < HEADLESS_BROWSER_IDLE_MS) return { reap: false };
  return { reap: true, reason: input.orphaned ? 'orphaned-idle' : 'idle' };
}
