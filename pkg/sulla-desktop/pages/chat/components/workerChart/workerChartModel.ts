// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type WorkerChartState = 'working' | 'parked' | 'needs-you' | 'failed' | 'done';

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

/**
 * Presentation-only structure. The chat adapter can map its live presenter into
 * this shape without making the chart depend on any job-store implementation.
 */
export interface WorkerChartAgent {
  id: string;
  name: string;
  initials: string;
  lane?: string | null;
  state: WorkerChartState;
  model?: string | null;
  task?: string | null;
  /** Epoch milliseconds from the agent/job record. */
  startedAt?: number | null;
  /** Epoch milliseconds from the agent/job record. */
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

export interface WorkerChartLayoutResult {
  rows: WorkerChartRow[];
  contentHeight: number;
}

export class WorkerChartLayout {
  /** How long a finished agent stays on the chart, with its done styling, before it drops off. */
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
    const rowHeight = rail ? this.railRowHeight : this.rowHeight;
    const indent = rail ? 0 : this.indent;
    let y = rail ? 8 : 2;

    const addNode = (agent: WorkerChartAgent, parentId: string | null, depth: number): void => {
      rows.push({
        kind: 'agent',
        key: agent.id,
        agent,
        parentId,
        depth,
        x: rail ? 7 : 8 + depth * indent,
        y,
      });
      y += rowHeight;

      const children = (agent.children ?? []).filter(child => !collapsedDoneIds.has(child.id));
      for (const child of children) addNode(child, agent.id, depth + 1);
    };

    addNode(root, null, 0);
    return { rows, contentHeight: y };
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

export class WorkerChartActivityWindow {
  public static readonly durationMs = 150_000;

  public recentSamples(
    samples: readonly WorkerChartActivitySample[] | undefined,
    now: number,
  ): WorkerChartActivitySample[] {
    const start = now - WorkerChartActivityWindow.durationMs;
    return (samples ?? [])
      .filter(sample => sample.timestamp >= start && sample.timestamp <= now)
      .slice()
      .sort((left, right) => left.timestamp - right.timestamp);
  }
}
