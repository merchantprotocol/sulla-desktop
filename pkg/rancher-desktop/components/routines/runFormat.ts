// Display helpers shared by the Studio workflows table and the canvas
// run-details card. Inputs are ISO strings from workflow_executions.

export type RunOutcome = 'ok' | 'failed' | 'running' | 'stopped';

export const OUTCOME_LABEL: Record<RunOutcome, string> = {
  ok:      'Succeeded',
  failed:  'Failed',
  running: 'Running',
  stopped: 'Stopped',
};

const DAY_MS = 86_400_000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function clock(d: Date): string {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** "Today 7:00 AM", "Yesterday 9:40 PM", "Mon 6:00 AM", "Oct 21 9:40 PM". */
export function formatWhen(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const days = Math.round((startOfDay(d) - startOfDay(now)) / DAY_MS);
  if (days === 0) return `Today ${ clock(d) }`;
  if (days === -1) return `Yesterday ${ clock(d) }`;
  if (days === 1) return `Tomorrow ${ clock(d) }`;
  if (days > 1 && days < 7) return `${ d.toLocaleDateString([], { weekday: 'short' }) } ${ clock(d) }`;

  return `${ d.toLocaleDateString([], { month: 'short', day: 'numeric' }) } ${ clock(d) }`;
}

/** Next-fire label: "In 18 min" inside the hour, otherwise formatWhen. */
export function formatNext(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - now.getTime();
  if (Number.isNaN(ms)) return '—';
  if (ms < 60_000) return 'In under a minute';
  if (ms < 3_600_000) return `In ${ Math.round(ms / 60_000) } min`;

  return formatWhen(iso, now);
}

export function durationMs(startedAt: string | null, completedAt: string | null, now = Date.now()): number | null {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;

  return Math.max(0, end - start);
}

/** "41s", "2m 14s", "1h 05m". */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${ secs }s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${ mins }m ${ String(secs % 60).padStart(2, '0') }s`;

  return `${ Math.floor(mins / 60) }h ${ String(mins % 60).padStart(2, '0') }m`;
}
