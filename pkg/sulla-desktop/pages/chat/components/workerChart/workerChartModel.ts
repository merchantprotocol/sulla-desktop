// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type WorkerChartState = 'working' | 'parked' | 'idle' | 'needs-you' | 'failed' | 'done';
export type WorkerChartRole = 'main' | 'mgr' | 'wrk' | 'rev';
export type WorkerChartVisualState = 'working' | 'waiting' | 'idle' | 'blocked' | 'failed' | 'done';

export interface WorkerChartActivitySample {
  /** Epoch milliseconds from the real activity timeline. */
  timestamp: number;
  value: number;
}

export interface WorkerChartCheckIn {
  /** Epoch milliseconds from the live job/check-in record. */
  timestamp: number;
  text: string;
}

/** Presentation-only structure; IDs and hierarchy still come from the live thread-scoped presenter. */
export interface WorkerChartAgent {
  id: string;
  name: string;
  initials: string;
  role?: WorkerChartRole;
  lane?: string | null;
  state: WorkerChartState;
  model?: string | null;
  task?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  lastCheckIn?: WorkerChartCheckIn | null;
  activity?: readonly WorkerChartActivitySample[];
  children?: readonly WorkerChartAgent[];
}

export interface WorkerChartAgentRow {
  kind: 'agent';
  key: string;
  agent: WorkerChartAgent;
  parentId: string | null;
  depth: number;
  x: number;
  y: number;
}

export type WorkerChartRow = WorkerChartAgentRow;
export interface WorkerChartLayoutResult { rows: WorkerChartRow[]; contentHeight: number }

export type WorkerChartLink =
  | { kind: 'stem'; key: string; x: number; y: number; scaleY: number }
  | { kind: 'elbow'; key: string; x: number; y: number };

export class WorkerChartLayout {
  /** Keep real completed-job rows visible briefly before collapsing them out of the chart. */
  public static readonly doneLingerMs = 10_000;

  private readonly rowHeight = 26;
  private readonly railRowHeight = 13;
  private readonly indent = 14;

  public layout(
    root: WorkerChartAgent | null,
    rail: boolean,
    collapsedDoneIds: ReadonlySet<string>,
  ): WorkerChartLayoutResult {
    if (!root) return { rows: [], contentHeight: 0 };

    const rows: WorkerChartRow[] = [];
    const step = rail ? this.railRowHeight : this.rowHeight;
    let y = rail ? 8 : 2;
    this.appendAgent(root, null, 0, rail, collapsedDoneIds, rows, depth => {
      if (rail && rows.length > 0 && depth === 1) y += 6;
      const current = y;
      y += step;
      return current;
    });
    return { rows, contentHeight: y };
  }

  private appendAgent(
    agent: WorkerChartAgent,
    parentId: string | null,
    depth: number,
    rail: boolean,
    collapsedDoneIds: ReadonlySet<string>,
    rows: WorkerChartRow[],
    nextY: (depth: number) => number,
  ): void {
    rows.push({
      kind: 'agent', key: agent.id, agent, parentId, depth,
      x: rail ? 0 : depth * this.indent,
      y: nextY(depth),
    });

    const children = (agent.children ?? []).filter(child => !collapsedDoneIds.has(child.id));
    for (const child of children) {
      this.appendAgent(child, agent.id, depth + 1, rail, collapsedDoneIds, rows, nextY);
    }
  }

  public doneChildIds(root: WorkerChartAgent | null): string[] {
    if (!root) return [];
    const doneIds: string[] = [];
    const visit = (agent: WorkerChartAgent): void => {
      for (const child of agent.children ?? []) {
        if (child.state === 'done') doneIds.push(child.id);
        visit(child);
      }
    };
    visit(root);
    return doneIds;
  }

  public findAgent(root: WorkerChartAgent | null, id: string | null): WorkerChartAgent | null {
    if (!root || !id) return null;
    const visit = (agent: WorkerChartAgent): WorkerChartAgent | null => {
      if (agent.id === id) return agent;
      for (const child of agent.children ?? []) {
        const found = visit(child);
        if (found) return found;
      }
      return null;
    };
    return visit(root);
  }

}

/** Coordinates use the mockup's 8px node inset and 14px depth indent. */
export class WorkerChartGeometry {
  public links(rows: readonly WorkerChartRow[], rail: boolean): WorkerChartLink[] {
    if (rail) return [];
    const links: WorkerChartLink[] = [];
    for (const parent of rows) {
      const children = rows.filter(row => row.parentId === parent.agent.id);
      const lastChild = children[children.length - 1];
      if (lastChild) {
        links.push({
          kind: 'stem', key: `stem:${parent.agent.id}`,
          x: parent.x + 16.5, y: parent.y + 22,
          scaleY: Math.max(0, (lastChild.y - parent.y - 9) / 100),
        });
      }
      for (const child of children) {
        links.push({
          kind: 'elbow', key: `elbow:${parent.agent.id}:${child.key}`,
          x: child.x + 2.5, y: child.y + 12.5,
        });
      }
    }
    return links;
  }

  public shouldPing(state: WorkerChartState): boolean { return state === 'working' }

  public pulseDelay(agentId: string): string {
    let hash = 0;
    for (const character of agentId) hash = (hash * 31 + character.charCodeAt(0)) % 260;
    return `-${(hash / 100).toFixed(2)}s`;
  }
}

/** Ages real activity events into the mockup's fixed 44 × 3.5-second buckets. */
export class WorkerChartActivityBuckets {
  public static readonly count = 44;
  public static readonly bucketMs = 3_500;
  /** Each of the 44 visible bars owns a 3.5-second activity bucket (154 seconds total). */
  public static readonly durationMs = WorkerChartActivityBuckets.count * WorkerChartActivityBuckets.bucketMs;

  public values(samples: readonly WorkerChartActivitySample[] | undefined, now: number): number[] {
    const buckets = new Array<number>(WorkerChartActivityBuckets.count).fill(0);
    const start = now - WorkerChartActivityBuckets.durationMs;
    for (const sample of samples ?? []) {
      if (sample.timestamp < start || sample.timestamp > now) continue;
      const index = Math.min(WorkerChartActivityBuckets.count - 1,
        Math.floor((sample.timestamp - start) / WorkerChartActivityBuckets.bucketMs));
      buckets[index] += sample.value;
    }
    return buckets;
  }

  public scale(value: number, max: number): number {
    if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(max) || max <= 0) return 0.04;
    return Math.max(0.04, value / max);
  }
}
