/**
 * Background-task completion plumbing for the Claude Code CLI.
 *
 * `claude -p` lets the model start background work (Bash run_in_background,
 * Monitor, …) and tells it "you will be notified when it completes". The CLI
 * keeps that promise only to ITSELF: when a task finishes after the turn's
 * `result`, it emits `system/task_notification` and — if stdin is still open —
 * runs a fresh autonomous turn (`system/init` … `result`) on its own. Observed
 * stream (CLI 2.1.282):
 *
 *   system/background_tasks_changed  { tasks: [{ task_id, … }] }
 *   system/task_started              { task_id, is_backgrounded: true }
 *   …                                result (the Sulla turn ends here)
 *   system/background_tasks_changed  { tasks: [] }
 *   system/task_notification         { task_id, status, summary, output_file }
 *   system/init                      (autonomous follow-up turn begins)
 *   assistant …                      result
 *
 * Nothing in Sulla's AgentGraph ever saw that second half: the warm pool
 * paused a parked process's stdout, reaped it (killing the task) after five
 * idle minutes, and discarded a buffered `result` as stale on the next claim.
 *
 * This module owns the two halves of the fix:
 *   - ClaudeBackgroundTaskTracker — per-process stream observer: which tasks
 *     are still live, and which completions (plus the CLI's own follow-up
 *     text) have not reached the graph yet.
 *   - BackgroundCompletionDelivery — routes finished completions into the
 *     owning graph thread with the same `user_message` wake spawn_agent uses,
 *     holding them while the thread is busy (a user_message on a running
 *     thread aborts that run) and handing any still-undelivered notices to
 *     the next turn's prompt as a fallback.
 */

import { isObserverSpawn } from './claudeToolPolicy';
import { getWebSocketClientService } from '../services/WebSocketClientService';

/** One finished background task, ready to hand to the graph. */
export interface BackgroundTaskNotice {
  taskId:       string;
  status:       string;
  summary:      string;
  outputFile?:  string;
  /** What the CLI itself replied in its autonomous follow-up turn, if any. */
  followUpText: string;
  completedAt:  number;
}

interface RawNotification {
  taskId:      string;
  status:      string;
  summary:     string;
  outputFile?: string;
  at:          number;
}

/**
 * Observes one CLI process's stream-json events. `observe` is fed every parsed
 * line, whether a Sulla turn owns the process (`parked=false`) or not.
 * Completions that arrive while parked are collected; when the autonomous
 * follow-up turn they trigger finishes (its `result`), they are emitted
 * together with that turn's text. `flush` emits anything left over when no
 * follow-up turn will ever run (stdin closed, process exited).
 */
export class ClaudeBackgroundTaskTracker {
  private readonly live = new Map<string, string>();
  private pending: RawNotification[] = [];
  private autonomousTurn = false;

  constructor(private readonly onNotices: (notices: BackgroundTaskNotice[]) => void) {}

  /** Background tasks the CLI still reports as running. */
  get liveTaskCount(): number {
    return this.live.size;
  }

  /** True while the CLI is running a follow-up turn nobody in Sulla asked for. */
  get inAutonomousTurn(): boolean {
    return this.autonomousTurn;
  }

  /** Completions collected but not emitted yet. */
  get pendingCount(): number {
    return this.pending.length;
  }

  observe(parsed: any, parked: boolean): void {
    if (!parsed || typeof parsed !== 'object') return;

    if (parsed.type === 'system') {
      switch (parsed.subtype) {
      case 'background_tasks_changed':
        this.live.clear();
        for (const t of Array.isArray(parsed.tasks) ? parsed.tasks : []) {
          if (t?.task_id) this.live.set(String(t.task_id), String(t.description ?? ''));
        }
        return;
      case 'task_started':
        if (parsed.is_backgrounded && parsed.task_id) {
          this.live.set(String(parsed.task_id), String(parsed.description ?? ''));
        }
        return;
      case 'task_notification':
        if (parsed.task_id) this.live.delete(String(parsed.task_id));
        // An owned turn sees the notification in its own context — only
        // completions that land while nobody is listening need delivering.
        if (!parked) return;
        this.pending.push({
          taskId:     String(parsed.task_id ?? ''),
          status:     String(parsed.status ?? 'completed'),
          summary:    String(parsed.summary ?? 'Background task finished'),
          outputFile: typeof parsed.output_file === 'string' ? parsed.output_file : undefined,
          at:         Date.now(),
        });
        return;
      case 'init':
        if (parked && this.pending.length > 0) this.autonomousTurn = true;
        return;
      default:
        return;
      }
    }

    if (parsed.type === 'result' && parked && this.pending.length > 0) {
      const followUp = typeof parsed.result === 'string' && !parsed.is_error ? parsed.result : '';
      this.autonomousTurn = false;
      this.emit(followUp);
    }
  }

  /** Emit any collected completions without a follow-up turn. */
  flush(): void {
    this.autonomousTurn = false;
    if (this.pending.length > 0) this.emit('');
  }

  private emit(followUpText: string): void {
    const notices = this.pending.map(n => ({
      taskId:      n.taskId,
      status:      n.status,
      summary:     n.summary,
      outputFile:  n.outputFile,
      followUpText,
      completedAt: n.at,
    }));
    this.pending = [];
    try {
      this.onNotices(notices);
    } catch (err) {
      console.warn('[ClaudeBackgroundTasks] notice handler failed:', err);
    }
  }
}

/** Where a conversation's completions should wake the graph. */
export interface WakeTarget {
  channel:  string;
  threadId: string;
  /** Live graph state for the thread — read only to detect busy vs idle. */
  state:    any;
}

/**
 * Resolve the wake target for a graph state, or null when waking it would be
 * wrong: sub-agents have already returned to their parent (a wake would start
 * an orphan turn) and observers never run background work.
 */
export function wakeTargetFromState(state: any): WakeTarget | null {
  const meta = state?.metadata;
  if (!meta || meta.isSubAgent || isObserverSpawn(meta)) return null;
  const channel = typeof meta.wsChannel === 'string' ? meta.wsChannel : '';
  const threadId = typeof meta.threadId === 'string' ? meta.threadId : '';
  if (!channel || !threadId) return null;

  return { channel, threadId, state };
}

/** Format notices as the wake message / prompt preamble the model reads. */
export function formatBackgroundNotices(notices: BackgroundTaskNotice[]): string {
  const blocks = notices.map((n) => {
    const lines = [`- ${ n.summary } [${ n.status }] (task ${ n.taskId })`];
    if (n.outputFile) lines.push(`  Output file: ${ n.outputFile }`);
    return lines.join('\n');
  });
  const followUp = notices.find(n => n.followUpText.trim())?.followUpText.trim();
  const parts = [
    `[Background task${ notices.length === 1 ? '' : 's' } finished while you were idle]`,
    blocks.join('\n'),
  ];
  if (followUp) {
    parts.push(`Your Claude session already reacted to this notification with:\n"""\n${ followUp }\n"""`);
  }
  parts.push('This is an automatic completion notice, not a message typed by the human. ' +
    'Act on the result now (read the output if you need it) and report the outcome to the human if it matters.');

  return parts.join('\n\n');
}

/** How often a held completion re-checks whether its thread went idle. */
const BUSY_RETRY_MS = 15_000;
/** Stop retrying a wake after this long; the notice then waits for the next turn's prompt. */
const MAX_WAKE_WAIT_MS = 60 * 60_000;
/** Drop never-claimed notices after this long so the queue can't grow forever. */
const PENDING_TTL_MS = 24 * 60 * 60_000;

interface PendingEntry {
  notices:  BackgroundTaskNotice[];
  target:   WakeTarget | null;
  queuedAt: number;
  timer:    ReturnType<typeof setTimeout> | null;
}

type SendFn = (channel: string, message: any) => Promise<unknown> | unknown;

/**
 * Delivers background-task completions into the conversation's graph thread.
 * Idle thread → wake now. Busy thread → hold and retry until idle (never
 * abort the running turn). No wake target, or the thread never went idle →
 * keep the notices for the next turn's prompt via `takePending`.
 */
export class BackgroundCompletionDelivery {
  private readonly pending = new Map<string, PendingEntry>();

  constructor(
    private readonly send: SendFn = (channel, message) => getWebSocketClientService().send(channel, message),
    private readonly now: () => number = Date.now,
  ) {}

  deliver(convId: string, target: WakeTarget | null, notices: BackgroundTaskNotice[]): void {
    if (notices.length === 0) return;
    this.prune();
    const existing = this.pending.get(convId);
    const entry: PendingEntry = existing ?? { notices: [], target, queuedAt: this.now(), timer: null };
    entry.notices.push(...notices);
    if (target) entry.target = target;
    this.pending.set(convId, entry);
    this.attempt(convId);
  }

  /** Hand undelivered notices to a turn that is about to run for this conversation. */
  takePending(convId: string): BackgroundTaskNotice[] {
    const entry = this.pending.get(convId);
    if (!entry) return [];
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(convId);

    return entry.notices;
  }

  hasPending(convId: string): boolean {
    return this.pending.has(convId);
  }

  private attempt(convId: string): void {
    const entry = this.pending.get(convId);
    if (!entry) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    const target = entry.target;
    if (!target) {
      console.log(`[ClaudeBackgroundTasks] No wake target for convId=${ convId }; holding ${ entry.notices.length } completion(s) for its next turn`);
      return;
    }

    if (target.state?.metadata?.cycleComplete === true) {
      this.pending.delete(convId);
      this.wake(convId, target, entry.notices);
      return;
    }

    if (this.now() - entry.queuedAt >= MAX_WAKE_WAIT_MS) {
      console.warn(`[ClaudeBackgroundTasks] Thread ${ target.threadId } stayed busy; holding completion(s) for its next turn`);
      return;
    }
    entry.timer = setTimeout(() => this.attempt(convId), BUSY_RETRY_MS);
    entry.timer.unref?.();
  }

  private wake(convId: string, target: WakeTarget, notices: BackgroundTaskNotice[]): void {
    const payload = {
      type: 'user_message',
      data: {
        content:  formatBackgroundNotices(notices),
        threadId: target.threadId,
        metadata: {
          source:      'background_task_completion',
          origin:      'claude_code',
          inputSource: 'system',
          taskIds:     notices.map(n => n.taskId),
        },
      },
    };
    const requeue = (err: unknown) => {
      console.warn(`[ClaudeBackgroundTasks] Wake failed for convId=${ convId }; holding for next turn:`, err);
      const entry = this.pending.get(convId);
      if (entry) entry.notices.unshift(...notices);
      else this.pending.set(convId, { notices: [...notices], target: null, queuedAt: this.now(), timer: null });
    };
    try {
      Promise.resolve(this.send(target.channel, payload)).then(
        () => console.log(`[ClaudeBackgroundTasks] Woke graph — channel="${ target.channel }" thread="${ target.threadId.slice(-8) }" tasks=${ notices.map(n => n.taskId).join(',') }`),
        requeue,
      );
    } catch (err) {
      requeue(err);
    }
  }

  private prune(): void {
    const cutoff = this.now() - PENDING_TTL_MS;
    for (const [convId, entry] of this.pending) {
      if (entry.queuedAt < cutoff && !entry.timer) this.pending.delete(convId);
    }
  }
}
