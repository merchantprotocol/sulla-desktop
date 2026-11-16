// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { inject, type InjectionKey } from 'vue';

/** When a transcript line happened: the short label (empty when the line above
 *  is in the same minute) and the full date for hover. */
export interface LineTime { label: string; full: string }

export const LineTimeKey: InjectionKey<(id: string) => LineTime | undefined> = Symbol('LineTime');

/**
 * The creation time carried in a backend message id (`1794757208708_ws_…`).
 * Older saves stored the time the window first saw a message (often a
 * restart), so the id is the more truthful source when it has one.
 */
function idTime(id: string, now = Date.now()): number | undefined {
  const at = Number(/^(?:thinking-group:)?(\d{13})_/.exec(id)?.[1]);
  return at > 1_500_000_000_000 && at <= now + 60_000 ? at : undefined;
}

/** "2:28 PM" today, "Nov 14, 2:28 PM" before today. */
function shortTime(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (new Date(now).toDateString() === date.toDateString()) return time;
  return `${ date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }, ${ time }`;
}

function fullTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'long' });
}

/**
 * A time for each line, shown only when its minute differs from the line
 * above, so a run of blocks in the same minute doesn't repeat "2:28 PM".
 */
function lineTimes(lines: readonly { id: string; at: number }[], now = Date.now()): Map<string, LineTime> {
  const out = new Map<string, LineTime>();
  let previous = '';
  for (const line of lines) {
    if (!Number.isFinite(line.at) || line.at <= 0) continue;
    const label = shortTime(line.at, now);
    out.set(line.id, { label: label === previous ? '' : label, full: fullTime(line.at) });
    previous = label;
  }
  return out;
}

/** The time for one line, from the transcript around it. */
function useLineTime(): (id: string) => LineTime | undefined {
  return inject(LineTimeKey, () => undefined);
}

/** When a transcript line happened: times from ids and stamps, and the per-line lookup. */
export class LineTimes {
  static readonly idTime = idTime;
  static readonly shortTime = shortTime;
  static readonly fullTime = fullTime;
  static readonly lineTimes = lineTimes;
  static readonly useLineTime = useLineTime;
}
