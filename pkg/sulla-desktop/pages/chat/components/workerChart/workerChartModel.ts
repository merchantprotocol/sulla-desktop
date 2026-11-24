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

export interface WorkerChartGroupRow {
  kind: 'group';
  key: string;
  parentId: string;
  depth: number;
  x: number;
  y: number;
  hiddenCount: number;
  expanded: boolean;
}

export type WorkerChartRow = WorkerChartAgentRow | WorkerChartGroupRow;

export interface WorkerChartLayoutResult {
  rows: WorkerChartRow[];
  contentHeight: number;
}

export class WorkerChartLayout {
  private readonly rowHeight = 26;
  private readonly railRowHeight = 13;
  private readonly indent = 14;
  private readonly urgentStates = new Set<WorkerChartState>(['needs-you', 'failed']);

  public layout(
    root: WorkerChartAgent | null,
    expandedParentIds: ReadonlySet<string>,
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
      if (children.length > 3 && !expandedParentIds.has(agent.id)) {
        const visibleIds = new Set(this.visibleSiblings(children).map(child => child.id));
        for (const child of children) {
          if (visibleIds.has(child.id)) addNode(child, agent.id, depth + 1);
        }
        rows.push({
          kind: 'group',
          key: `group:${agent.id}`,
          parentId: agent.id,
          depth: depth + 1,
          x: rail ? 7 : 8 + (depth + 1) * indent,
          y,
          hiddenCount: children.length - visibleIds.size,
          expanded: false,
        });
        y += rowHeight;
        return;
      }

      for (const child of children) addNode(child, agent.id, depth + 1);

      if (children.length > 3) {
        rows.push({
          kind: 'group',
          key: `group:${agent.id}`,
          parentId: agent.id,
          depth: depth + 1,
          x: rail ? 7 : 8 + (depth + 1) * indent,
          y,
          hiddenCount: 0,
          expanded: true,
        });
        y += rowHeight;
      }
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

  private visibleSiblings(children: readonly WorkerChartAgent[]): WorkerChartAgent[] {
    const urgent = children.filter(child => this.urgentStates.has(child.state));
    const keepCount = Math.max(2, urgent.length);
    const visibleIds = new Set(urgent.map(child => child.id));
    for (const child of children) {
      if (visibleIds.size >= keepCount) break;
      visibleIds.add(child.id);
    }
    return children.filter(child => visibleIds.has(child.id));
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
