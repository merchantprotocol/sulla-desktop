// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { computed, nextTick, ref, watch, type ComputedRef } from 'vue';

import type { WorkerChartOverlayController } from './WorkerChartOverlayController';
import type { WorkerChartTimeFormatter } from './WorkerChartTimeFormatter';
import {
  WorkerChartActivityBuckets,
  WorkerChartGeometry,
  WorkerChartLayout,
  type WorkerChartAgent,
  type WorkerChartGroupRow,
  type WorkerChartLayoutResult,
  type WorkerChartLink,
  type WorkerChartRow,
  type WorkerChartState,
} from './workerChartModel';

export interface WorkerChartSnippetTick { agentId: string; sequence: number }

export interface WorkerChartControllerSources {
  root: ComputedRef<WorkerChartAgent | null>;
  chatColumnWidth: ComputedRef<number>;
  snippetTick: ComputedRef<WorkerChartSnippetTick | null | undefined>;
  instanceId: string;
  openAgent: (payload: { agentId: string }) => void;
}

export class WorkerChartController {
  public readonly collapsedDoneIds = ref<Set<string>>(new Set());
  public readonly expandedGroupIds = ref<Set<string>>(new Set());
  public readonly now = ref(Date.now());
  public readonly pageHidden = ref(false);

  private readonly doneTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly nodeAnimations = new Map<string, Animation>();
  private readonly pausedAnimations = new Set<Animation>();
  private readonly chartValue: ComputedRef<WorkerChartLayoutResult>;
  private readonly doneIdsValue: ComputedRef<string[]>;
  private readonly stopWatches: (() => void)[] = [];
  private nowTimer: ReturnType<typeof setInterval> | null = null;
  private previousRows: readonly WorkerChartRow[] = [];

  public constructor(
    private readonly sources: WorkerChartControllerSources,
    private readonly layout: WorkerChartLayout,
    private readonly geometry: WorkerChartGeometry,
    private readonly activityBuckets: WorkerChartActivityBuckets,
    private readonly timeFormatter: WorkerChartTimeFormatter,
    public readonly interaction: WorkerChartOverlayController,
  ) {
    this.chartValue = computed(() => this.layout.layout(
      this.sources.root.value,
      this.isRail,
      this.collapsedDoneIds.value,
      this.expandedGroupIds.value,
    ));
    this.doneIdsValue = computed(() => this.layout.doneChildIds(this.sources.root.value));
    this.previousRows = this.chartValue.value.rows;
    this.interaction.connect(this.chartValue, computed(() => this.isNarrow));
    this.watchModelChanges();
  }

  public get chart(): WorkerChartLayoutResult { return this.chartValue.value }
  public get links(): WorkerChartLink[] { return this.geometry.links(this.chart.rows, this.isRail) }
  public get isNarrow(): boolean { return this.sources.chatColumnWidth.value < 900 }
  public get isRail(): boolean { return this.isNarrow && !this.interaction.chartOverlayOpen.value }
  public get overlayOpen(): boolean { return this.interaction.overlayOpen }
  public get hidden(): boolean { return this.pageHidden.value }
  public get ready(): boolean { return this.interaction.ready }
  public get overlayPosition(): Record<string, string> { return this.interaction.overlayPosition }
  public get popoverPosition(): Record<string, string> { return this.interaction.popoverPosition }
  public get selectedId(): string | null { return this.interaction.selectedId }
  public get hoveredKey(): string | null { return this.interaction.hoveredKey }
  public get isPopoverOpen(): boolean { return this.interaction.isPopoverOpen }
  public get popoverId(): string { return this.interaction.popoverId }
  public get activePopoverAgent(): WorkerChartAgent | null { return this.interaction.activePopoverAgent }
  public get activePopoverGroup(): WorkerChartGroupRow | null { return this.interaction.activePopoverGroup }
  public get host() { return this.interaction.host }
  public get railTrigger() { return this.interaction.railTrigger }
  public get chartSurface() { return this.interaction.chartSurface }
  public get tree() { return this.interaction.tree }
  public get popover() { return this.interaction.popover }
  public get activityValues(): number[] {
    return this.activityBuckets.values(this.activePopoverAgent?.activity, this.now.value);
  }
  public get selected(): boolean { return this.interaction.selected }

  public rowStyle(row: WorkerChartRow): Record<string, string> {
    return { left: `${this.isRail ? 7.5 : 8 + row.x}px`, top: `${row.y}px` };
  }

  public rowState(row: WorkerChartRow): WorkerChartState | null {
    if (row.kind === 'agent') return row.agent.state;
    if (row.expanded) return null;
    return row.hiddenAgents.some(agent => agent.state === 'working') ? 'working' : 'parked';
  }

  public rowPings(row: WorkerChartRow): boolean {
    const state = this.rowState(row);
    return state !== null && this.geometry.shouldPing(state);
  }

  public pulseDelay(row: WorkerChartRow): string {
    return row.kind === 'agent' ? this.geometry.pulseDelay(row.agent.id) : '0s';
  }

  public registerButton(key: string, element: HTMLButtonElement | null): void {
    this.interaction.registerButton(key, element);
  }

  public registerPopover(element: HTMLElement | null): void { this.interaction.registerPopover(element) }

  public elapsed(agent: WorkerChartAgent): string { return this.timeFormatter.elapsed(agent, this.now.value) }
  public lastCheckInTime(agent: WorkerChartAgent): string { return this.timeFormatter.lastCheckIn(agent, this.now.value) }

  public mount(): void {
    this.pageHidden.value = document.hidden;
    this.nowTimer = setInterval(() => {
      if (!document.hidden) this.now.value = Date.now();
    }, 1_000);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.interaction.mount();
  }

  public unmount(): void {
    if (this.nowTimer) clearInterval(this.nowTimer);
    for (const timer of this.doneTimers.values()) clearTimeout(timer);
    for (const animation of this.nodeAnimations.values()) animation.cancel();
    for (const stop of this.stopWatches) stop();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.interaction.unmount();
  }

  private watchModelChanges(): void {
    this.stopWatches.push(watch(this.doneIdsValue, ids => {
      const current = new Set(ids);
      for (const [id, timer] of this.doneTimers) {
        if (!current.has(id)) {
          clearTimeout(timer);
          this.doneTimers.delete(id);
          this.collapsedDoneIds.value = new Set([...this.collapsedDoneIds.value].filter(doneId => doneId !== id));
        }
      }
      for (const id of ids) {
        if (this.collapsedDoneIds.value.has(id) || this.doneTimers.has(id)) continue;
        this.doneTimers.set(id, setTimeout(() => {
          this.doneTimers.delete(id);
          this.collapsedDoneIds.value = new Set([...this.collapsedDoneIds.value, id]);
        }, WorkerChartLayout.doneLingerMs));
      }
    }, { immediate: true }));

    this.stopWatches.push(watch(this.chartValue, (_current, previous) => {
      this.previousRows = previous.rows;
    }));
    this.stopWatches.push(watch(() => this.sources.snippetTick.value?.sequence, sequence => {
      const agentId = this.sources.snippetTick.value?.agentId;
      if (sequence == null || !agentId) return;
      void nextTick(() => this.animateActivityNode(agentId));
    }));
  }

  private animateActivityNode(agentId: string): void {
    if (document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const group = this.chart.rows.find(row => row.kind === 'group' && row.hiddenAgents.some(agent => this.containsAgent(agent, agentId)));
    const buttonKey = group?.key ?? agentId;
    const button = this.interaction.button(buttonKey);
    const marker = button?.querySelector<HTMLElement>('.worker-chart__marker');
    if (!marker) return;
    this.nodeAnimations.get(buttonKey)?.cancel();
    const animation = marker.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.28)' }, { transform: 'scale(1)' }],
      { duration: 320, easing: 'cubic-bezier(.22, 1, .36, 1)' },
    );
    this.nodeAnimations.set(buttonKey, animation);
    animation.onfinish = () => this.nodeAnimations.delete(buttonKey);
  }

  private containsAgent(agent: WorkerChartAgent, id: string): boolean {
    return agent.id === id || (agent.children ?? []).some(child => this.containsAgent(child, id));
  }

  public toggleOverlay(): void { this.interaction.toggleOverlay() }
  public closeChartOverlay(restoreFocus: boolean): void { this.interaction.closeChartOverlay(restoreFocus) }

  public activate(row: WorkerChartRow): void {
    if (row.kind === 'group') {
      const next = new Set(this.expandedGroupIds.value);
      row.expanded ? next.delete(row.agent.id) : next.add(row.agent.id);
      this.expandedGroupIds.value = next;
      this.interaction.dismissPopover(false);
      return;
    }
    this.interaction.toggleAgentPopover(row.agent.id);
  }

  public onNodeEnter(row: WorkerChartRow): void { this.interaction.onNodeEnter(row) }
  public onNodeLeave(row: WorkerChartRow): void { this.interaction.onNodeLeave(row) }
  public onNodeFocus(row: WorkerChartRow): void { this.interaction.onNodeFocus(row) }
  public onNodeBlur(event: FocusEvent): void { this.interaction.onNodeBlur(event) }
  public scheduleTooltipClose(): void { this.interaction.scheduleTooltipClose() }
  public cancelTooltipClose(): void { this.interaction.cancelTooltipClose() }
  public openAgent(agentId: string): void { this.interaction.openAgent(agentId) }
  public repositionPopover(): void { this.interaction.repositionPopover() }

  private onVisibilityChange = (): void => {
    this.pageHidden.value = document.hidden;
    if (!document.hidden) this.now.value = Date.now();
    const animations = new Set([
      ...this.nodeAnimations.values(),
      ...(typeof document.getAnimations === 'function' ? document.getAnimations() : []),
    ]);
    if (document.hidden) {
      for (const animation of animations) {
        if (animation.playState !== 'running') continue;
        animation.pause();
        this.pausedAnimations.add(animation);
      }
      return;
    }
    for (const animation of this.pausedAnimations) {
      if (animation.playState === 'paused') animation.play();
    }
    this.pausedAnimations.clear();
  };

  public beforeRowEnter(element: Element): void {
    const row = element as HTMLElement;
    const parent = this.layout.findAgent(this.sources.root.value, row.dataset.parentId || null);
    const parentRow = parent ? this.chart.rows.find(candidate => candidate.kind === 'agent' && candidate.agent.id === parent.id) : null;
    const thisRow = this.chart.rows.find(candidate => candidate.key === row.dataset.rowKey);
    if (!thisRow) return;
    row.style.setProperty('--worker-chart-enter-x', `${(parentRow?.x ?? thisRow.x) - thisRow.x}px`);
    row.style.setProperty('--worker-chart-enter-y', `${(parentRow?.y ?? thisRow.y) - thisRow.y}px`);
  }

  public beforeRowLeave(element: Element): void {
    const row = element as HTMLElement;
    const parentId = row.dataset.parentId;
    const parentRow = this.chart.rows.find(candidate => candidate.kind === 'agent' && candidate.agent.id === parentId)
      ?? this.previousRows.find(candidate => candidate.kind === 'agent' && candidate.agent.id === parentId);
    const leavingRow = this.previousRows.find(candidate => candidate.key === row.dataset.rowKey);
    if (parentRow && leavingRow) {
      row.style.setProperty('--worker-chart-leave-x', `${parentRow.x + 14 - leavingRow.x}px`);
      row.style.setProperty('--worker-chart-leave-y', `${parentRow.y - leavingRow.y}px`);
      return;
    }
    row.style.setProperty('--worker-chart-leave-x', '0px');
    row.style.setProperty('--worker-chart-leave-y', '-8px');
  }
}
