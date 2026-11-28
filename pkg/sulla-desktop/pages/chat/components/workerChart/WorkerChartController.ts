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
  type WorkerChartLayoutResult,
  type WorkerChartLink,
  type WorkerChartRow,
} from './workerChartModel';

export interface WorkerChartSnippetTick { agentId: string; sequence: number }

export interface WorkerChartControllerSources {
  root: ComputedRef<WorkerChartAgent | null>;
  chatColumnWidth: ComputedRef<number>;
  snippetTick: ComputedRef<WorkerChartSnippetTick | null | undefined>;
  /** Shared thread-activity clock; chart rows never allocate their own tickers. */
  now?: ComputedRef<number> | (() => number);
  instanceId: string;
  openAgent: (payload: { agentId: string }) => void;
}

export class WorkerChartController {
  public readonly collapsedDoneIds = ref<Set<string>>(new Set());
  public readonly pageHidden = ref(false);

  private readonly doneTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly nodeAnimations = new Map<string, Animation>();
  private readonly pausedAnimations = new Set<Animation>();
  private readonly chartValue: ComputedRef<WorkerChartLayoutResult>;
  private readonly doneIdsValue: ComputedRef<string[]>;
  private readonly stopWatches: (() => void)[] = [];
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
  public readonly currentNow = (): number => {
    const source = this.sources.now;
    return typeof source === 'function' ? source() : source?.value ?? Date.now();
  };
  public get host() { return this.interaction.host }
  public get railTrigger() { return this.interaction.railTrigger }
  public get chartSurface() { return this.interaction.chartSurface }
  public get tree() { return this.interaction.tree }
  public get popover() { return this.interaction.popover }
  public get activityValues(): number[] {
    return this.activityBuckets.values(this.activePopoverAgent?.activity, this.currentNow());
  }
  public get selected(): boolean { return this.interaction.selected }

  public rowStyle(row: WorkerChartRow): Record<string, string> {
    return { left: `${this.isRail ? 7.5 : 8 + row.x}px`, top: `${row.y}px` };
  }

  public rowPings(row: WorkerChartRow): boolean {
    return this.geometry.shouldPing(row.agent.state);
  }

  public pulseDelay(row: WorkerChartRow): string {
    return this.geometry.pulseDelay(row.agent.id);
  }

  public registerButton(key: string, element: HTMLButtonElement | null): void {
    this.interaction.registerButton(key, element);
  }

  public registerPopover(element: HTMLElement | null): void { this.interaction.registerPopover(element) }

  public elapsed(agent: WorkerChartAgent): string { return this.timeFormatter.elapsed(agent, this.currentNow()) }
  public lastCheckInTime(agent: WorkerChartAgent): string { return this.timeFormatter.lastCheckIn(agent, this.currentNow()) }

  public mount(): void {
    this.pageHidden.value = document.hidden;
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.interaction.mount();
  }

  public unmount(): void {
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
    const button = this.interaction.button(agentId);
    const marker = button?.querySelector<HTMLElement>('.worker-chart__marker');
    if (!marker) return;
    this.nodeAnimations.get(agentId)?.cancel();
    const animation = marker.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.28)' }, { transform: 'scale(1)' }],
      { duration: 320, easing: 'cubic-bezier(.22, 1, .36, 1)' },
    );
    this.nodeAnimations.set(agentId, animation);
    animation.onfinish = () => this.nodeAnimations.delete(agentId);
  }

  public toggleOverlay(): void { this.interaction.toggleOverlay() }
  public closeChartOverlay(restoreFocus: boolean): void { this.interaction.closeChartOverlay(restoreFocus) }

  public activate(row: WorkerChartRow): void {
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
    const parentRow = parent ? this.chart.rows.find(candidate => candidate.agent.id === parent.id) : null;
    const thisRow = this.chart.rows.find(candidate => candidate.key === row.dataset.rowKey);
    if (!thisRow) return;
    row.style.setProperty('--worker-chart-enter-x', `${(parentRow?.x ?? thisRow.x) - thisRow.x}px`);
    row.style.setProperty('--worker-chart-enter-y', `${(parentRow?.y ?? thisRow.y) - thisRow.y}px`);
  }

  public beforeRowLeave(element: Element): void {
    const row = element as HTMLElement;
    const parentId = row.dataset.parentId;
    const parentRow = this.chart.rows.find(candidate => candidate.agent.id === parentId)
      ?? this.previousRows.find(candidate => candidate.agent.id === parentId);
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
