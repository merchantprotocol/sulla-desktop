// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { computed, nextTick, ref, watch, type ComputedRef } from 'vue';

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
  public readonly host = ref<HTMLElement | null>(null);
  public readonly railTrigger = ref<HTMLButtonElement | null>(null);
  public readonly chartSurface = ref<HTMLElement | null>(null);
  public readonly tree = ref<HTMLElement | null>(null);
  public readonly popover = ref<HTMLElement | null>(null);
  public readonly collapsedDoneIds = ref<Set<string>>(new Set());
  public readonly expandedGroupIds = ref<Set<string>>(new Set());
  public readonly selectedAgentId = ref<string | null>(null);
  public readonly hoveredRowKey = ref<string | null>(null);
  public readonly chartOverlayOpen = ref(false);
  public readonly now = ref(Date.now());
  public readonly pageHidden = ref(false);
  public readonly popoverReady = ref(false);
  public readonly overlayStyle = ref<Record<string, string>>({ right: '0px' });
  public readonly popoverStyle = ref<Record<string, string>>({ left: '-10000px', top: '0px' });

  private readonly nodeButtons = new Map<string, HTMLButtonElement>();
  private readonly doneTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly nodeAnimations = new Map<string, Animation>();
  private readonly chartValue: ComputedRef<WorkerChartLayoutResult>;
  private readonly doneIdsValue: ComputedRef<string[]>;
  private readonly activeRowValue: ComputedRef<WorkerChartRow | null>;
  private readonly stopWatches: (() => void)[] = [];
  private nowTimer: ReturnType<typeof setInterval> | null = null;
  private tooltipCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private suppressTooltipOnFocus = false;

  public constructor(
    private readonly sources: WorkerChartControllerSources,
    private readonly layout: WorkerChartLayout,
    private readonly geometry: WorkerChartGeometry,
    private readonly activityBuckets: WorkerChartActivityBuckets,
    private readonly timeFormatter: WorkerChartTimeFormatter,
  ) {
    this.chartValue = computed(() => this.layout.layout(
      this.sources.root.value,
      this.isRail,
      this.collapsedDoneIds.value,
      this.expandedGroupIds.value,
    ));
    this.doneIdsValue = computed(() => this.layout.doneChildIds(this.sources.root.value));
    this.activeRowValue = computed(() => {
      const key = this.selectedAgentId.value ?? this.hoveredRowKey.value;
      return this.chartValue.value.rows.find(row => row.key === key) ?? null;
    });
    this.watchModelChanges();
  }

  public get chart(): WorkerChartLayoutResult { return this.chartValue.value }
  public get links(): WorkerChartLink[] { return this.geometry.links(this.chart.rows, this.isRail) }
  public get isNarrow(): boolean { return this.sources.chatColumnWidth.value < 900 }
  public get isRail(): boolean { return this.isNarrow && !this.chartOverlayOpen.value }
  public get overlayOpen(): boolean { return this.chartOverlayOpen.value }
  public get hidden(): boolean { return this.pageHidden.value }
  public get ready(): boolean { return this.popoverReady.value }
  public get overlayPosition(): Record<string, string> { return this.overlayStyle.value }
  public get popoverPosition(): Record<string, string> { return this.popoverStyle.value }
  public get selectedId(): string | null { return this.selectedAgentId.value }
  public get hoveredKey(): string | null { return this.hoveredRowKey.value }
  public get isPopoverOpen(): boolean { return this.activeRowValue.value !== null }
  public get popoverId(): string { return `worker-chart-${this.sources.instanceId}-popover` }
  public get activePopoverAgent(): WorkerChartAgent | null {
    const row = this.activeRowValue.value;
    return row?.kind === 'agent' ? row.agent : null;
  }
  public get activePopoverGroup(): WorkerChartGroupRow | null {
    const row = this.activeRowValue.value;
    return row?.kind === 'group' ? row : null;
  }
  public get activityValues(): number[] {
    return this.activityBuckets.values(this.activePopoverAgent?.activity, this.now.value);
  }
  public get selected(): boolean { return this.selectedAgentId.value !== null }

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
    if (element) this.nodeButtons.set(key, element);
    else this.nodeButtons.delete(key);
  }

  public registerPopover(element: HTMLElement | null): void { this.popover.value = element }

  public elapsed(agent: WorkerChartAgent): string { return this.timeFormatter.elapsed(agent, this.now.value) }
  public lastCheckInTime(agent: WorkerChartAgent): string { return this.timeFormatter.lastCheckIn(agent, this.now.value) }

  public mount(): void {
    this.pageHidden.value = document.hidden;
    this.nowTimer = setInterval(() => {
      if (!document.hidden) this.now.value = Date.now();
    }, 1_000);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.addEventListener('keydown', this.onDocumentKeyDown, true);
    window.addEventListener('resize', this.onWindowResize);
  }

  public unmount(): void {
    if (this.nowTimer) clearInterval(this.nowTimer);
    if (this.tooltipCloseTimer) clearTimeout(this.tooltipCloseTimer);
    for (const timer of this.doneTimers.values()) clearTimeout(timer);
    for (const animation of this.nodeAnimations.values()) animation.cancel();
    for (const stop of this.stopWatches) stop();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
    window.removeEventListener('resize', this.onWindowResize);
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

    this.stopWatches.push(watch(this.chartValue, () => {
      const rows = this.chart.rows;
      if (this.selectedAgentId.value && !rows.some(row => row.kind === 'agent' && row.agent.id === this.selectedAgentId.value)) {
        this.dismissPopover(true, true);
      } else if (this.hoveredRowKey.value && !rows.some(row => row.key === this.hoveredRowKey.value)) {
        this.dismissPopover(false);
      }
      void nextTick(() => this.repositionPopover());
    }));

    this.stopWatches.push(watch(() => this.isNarrow, () => {
      this.chartOverlayOpen.value = false;
      if (this.selected || this.hoveredRowKey.value) this.dismissPopover(true, true);
    }));
    this.stopWatches.push(watch(this.sources.chatColumnWidth, () => void nextTick(() => {
      if (this.chartOverlayOpen.value) this.positionChartOverlay();
      this.repositionPopover();
    })));
    this.stopWatches.push(watch([this.selectedAgentId, this.hoveredRowKey], () => {
      this.popoverReady.value = false;
      const row = this.activeRowValue.value;
      if (row) void this.positionPopover(row.key);
    }));
    this.stopWatches.push(watch(() => this.sources.snippetTick.value?.sequence, sequence => {
      const agentId = this.sources.snippetTick.value?.agentId;
      if (sequence == null || !agentId) return;
      void nextTick(() => this.animateActivityNode(agentId));
    }));
  }

  private animateActivityNode(agentId: string): void {
    if (document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const button = this.nodeButtons.get(agentId);
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

  public toggleOverlay(): void {
    this.chartOverlayOpen.value = !this.chartOverlayOpen.value;
    if (this.chartOverlayOpen.value) {
      void nextTick(() => {
        this.positionChartOverlay();
        this.focusWithoutTooltip(this.tree.value?.querySelector<HTMLButtonElement>('[data-agent-id]') ?? null);
      });
    } else this.dismissPopover(false);
  }

  public closeChartOverlay(restoreFocus: boolean): void {
    this.chartOverlayOpen.value = false;
    this.dismissPopover(false);
    if (restoreFocus) void nextTick(() => this.focusWithoutTooltip(this.railTrigger.value));
  }

  public activate(row: WorkerChartRow): void {
    if (row.kind === 'group') {
      const next = new Set(this.expandedGroupIds.value);
      row.expanded ? next.delete(row.agent.id) : next.add(row.agent.id);
      this.expandedGroupIds.value = next;
      this.dismissPopover(false);
      return;
    }
    this.toggleAgentPopover(row.agent.id);
  }

  public onNodeEnter(row: WorkerChartRow): void {
    this.cancelTooltipClose();
    if (!this.selectedAgentId.value) this.hoveredRowKey.value = row.key;
  }

  public onNodeLeave(row: WorkerChartRow): void {
    if (!this.selectedAgentId.value && this.hoveredRowKey.value === row.key) this.scheduleTooltipClose();
  }

  public onNodeFocus(row: WorkerChartRow): void {
    if (!this.suppressTooltipOnFocus) this.onNodeEnter(row);
  }

  private focusWithoutTooltip(element: HTMLElement | null): void {
    if (!element?.isConnected) return;
    this.suppressTooltipOnFocus = true;
    try { element.focus({ preventScroll: true }) }
    finally { this.suppressTooltipOnFocus = false }
  }

  public scheduleTooltipClose(): void {
    if (this.tooltipCloseTimer) clearTimeout(this.tooltipCloseTimer);
    this.tooltipCloseTimer = setTimeout(() => {
      if (this.selectedAgentId.value || this.popover.value?.contains(document.activeElement)) return;
      this.hoveredRowKey.value = null;
    }, 140);
  }

  public cancelTooltipClose(): void {
    if (this.tooltipCloseTimer) clearTimeout(this.tooltipCloseTimer);
    this.tooltipCloseTimer = null;
  }

  public onNodeBlur(event: FocusEvent): void {
    if (this.selectedAgentId.value) return;
    if (event.relatedTarget instanceof Node && this.popover.value?.contains(event.relatedTarget)) return;
    this.scheduleTooltipClose();
  }

  private toggleAgentPopover(id: string): void {
    if (this.selectedAgentId.value === id) {
      this.dismissPopover(true);
      return;
    }
    this.selectedAgentId.value = id;
    this.hoveredRowKey.value = null;
    void nextTick(() => (this.popover.value ?? document.getElementById(this.popoverId))?.focus({ preventScroll: true }));
  }

  private dismissPopover(restoreFocus: boolean, fallback = false): void {
    const oldKey = this.selectedAgentId.value ?? this.hoveredRowKey.value;
    this.selectedAgentId.value = null;
    this.hoveredRowKey.value = null;
    this.popoverReady.value = false;
    if (!restoreFocus) return;
    void nextTick(() => {
      const trigger = oldKey ? this.nodeButtons.get(oldKey) : null;
      if (trigger?.isConnected && !fallback) { this.focusWithoutTooltip(trigger); return }
      if (this.isNarrow && this.railTrigger.value?.isConnected) { this.focusWithoutTooltip(this.railTrigger.value); return }
      const first = this.chart.rows[0];
      const firstButton = first ? this.nodeButtons.get(first.key) : null;
      if (firstButton?.isConnected) this.focusWithoutTooltip(firstButton);
      else if (this.host.value) { this.host.value.tabIndex = -1; this.focusWithoutTooltip(this.host.value) }
    });
  }

  public openAgent(agentId: string): void {
    this.sources.openAgent({ agentId });
    this.dismissPopover(true);
  }

  private async positionPopover(key: string): Promise<void> {
    await nextTick();
    const trigger = this.nodeButtons.get(key);
    const content = this.popover.value ?? document.getElementById(this.popoverId);
    if (!trigger || !content || !trigger.isConnected) return;
    const triggerRect = trigger.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const gap = 8;
    const margin = 8;
    let left = triggerRect.left - contentRect.width - gap;
    const flipRight = left < margin;
    if (flipRight) left = Math.min(window.innerWidth - contentRect.width - margin, triggerRect.right + gap);
    const top = Math.max(margin, Math.min(triggerRect.top - (this.selected ? 12 : 4), window.innerHeight - contentRect.height - margin));
    this.popoverStyle.value = { left: `${Math.max(margin, left)}px`, top: `${top}px`, transformOrigin: `${flipRight ? '0%' : '100%'} 20px` };
    this.popoverReady.value = true;
  }

  public repositionPopover(): void {
    const row = this.activeRowValue.value;
    if (row) void this.positionPopover(row.key);
  }

  private positionChartOverlay(): void {
    const bounds = this.host.value?.getBoundingClientRect();
    if (bounds) this.overlayStyle.value = { right: `${Math.max(0, window.innerWidth - bounds.right)}px` };
  }

  private onWindowResize = (): void => {
    this.positionChartOverlay();
    this.repositionPopover();
  };

  private onDocumentPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (this.host.value?.contains(target) || this.chartSurface.value?.contains(target) || this.popover.value?.contains(target)) return;
    if (this.selected || this.hoveredRowKey.value) this.dismissPopover(false);
    if (this.chartOverlayOpen.value && !this.chartSurface.value?.contains(target)) this.closeChartOverlay(false);
  };

  private onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    if (this.selected || this.hoveredRowKey.value) {
      event.stopPropagation();
      this.dismissPopover(true);
    } else if (this.chartOverlayOpen.value) {
      event.stopPropagation();
      this.closeChartOverlay(true);
    }
  };

  private onVisibilityChange = (): void => {
    this.pageHidden.value = document.hidden;
    if (!document.hidden) this.now.value = Date.now();
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
    const parentRow = this.chart.rows.find(candidate => candidate.kind === 'agent' && candidate.agent.id === parentId);
    const leavingRow = this.chart.rows.find(candidate => candidate.key === row.dataset.rowKey);
    if (parentRow && leavingRow) {
      row.style.setProperty('--worker-chart-leave-x', `${parentRow.x + 14 - leavingRow.x}px`);
      row.style.setProperty('--worker-chart-leave-y', `${parentRow.y - leavingRow.y}px`);
      return;
    }
    row.style.setProperty('--worker-chart-leave-x', '0px');
    row.style.setProperty('--worker-chart-leave-y', '-8px');
  }
}
