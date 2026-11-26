// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { computed, nextTick, ref, watch, type ComputedRef } from 'vue';

import type { WorkerChartControllerSources } from './WorkerChartController';
import type { WorkerChartAgent, WorkerChartLayoutResult, WorkerChartRow } from './workerChartModel';

/** Owns the worker-chart overlay, hover, keyboard, popover positioning and focus lifecycle. */
export class WorkerChartOverlayController {
  public readonly host = ref<HTMLElement | null>(null);
  public readonly railTrigger = ref<HTMLButtonElement | null>(null);
  public readonly chartSurface = ref<HTMLElement | null>(null);
  public readonly tree = ref<HTMLElement | null>(null);
  public readonly popover = ref<HTMLElement | null>(null);
  public readonly selectedAgentId = ref<string | null>(null);
  public readonly hoveredRowKey = ref<string | null>(null);
  public readonly chartOverlayOpen = ref(false);
  public readonly popoverReady = ref(false);
  public readonly overlayStyle = ref<Record<string, string>>({ right: '0px' });
  public readonly popoverStyle = ref<Record<string, string>>({ left: '-10000px', top: '0px' });

  private readonly nodeButtons = new Map<string, HTMLButtonElement>();
  private readonly stopWatches: (() => void)[] = [];
  private chartRows?: ComputedRef<WorkerChartRow[]>;
  private activeRowValue?: ComputedRef<WorkerChartRow | null>;
  private isNarrowValue?: ComputedRef<boolean>;
  private tooltipCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private suppressTooltipOnFocus = false;

  public constructor(private readonly sources: WorkerChartControllerSources) {}

  public connect(chart: ComputedRef<WorkerChartLayoutResult>, isNarrow: ComputedRef<boolean>): void {
    this.chartRows = computed(() => chart.value.rows);
    this.isNarrowValue = isNarrow;
    this.activeRowValue = computed(() => {
      const key = this.selectedAgentId.value ?? this.hoveredRowKey.value;
      return this.rows.find(row => row.key === key) ?? null;
    });
    this.stopWatches.push(watch(chart, () => {
      const rows = this.rows;
      if (this.selectedAgentId.value && !rows.some(row => row.agent.id === this.selectedAgentId.value)) {
        this.dismissPopover(true, true);
      } else if (this.hoveredRowKey.value && !rows.some(row => row.key === this.hoveredRowKey.value)) {
        this.dismissPopover(false);
      }
      void nextTick(() => this.repositionPopover());
    }));
    this.stopWatches.push(watch(isNarrow, () => {
      this.chartOverlayOpen.value = false;
      if (this.selected || this.hoveredRowKey.value) this.dismissPopover(true, true);
    }));
    this.stopWatches.push(watch(this.sources.chatColumnWidth, () => void nextTick(() => {
      if (this.chartOverlayOpen.value) this.positionChartOverlay();
      this.repositionPopover();
    })));
    this.stopWatches.push(watch([this.selectedAgentId, this.hoveredRowKey], () => {
      this.popoverReady.value = false;
      const row = this.activeRowValue?.value;
      if (row) void this.positionPopover(row.key);
    }));
  }

  public get rows(): WorkerChartRow[] { return this.chartRows?.value ?? [] }
  public get isNarrow(): boolean { return this.isNarrowValue?.value ?? false }
  public get overlayOpen(): boolean { return this.chartOverlayOpen.value }
  public get overlayPosition(): Record<string, string> { return this.overlayStyle.value }
  public get popoverPosition(): Record<string, string> { return this.popoverStyle.value }
  public get selectedId(): string | null { return this.selectedAgentId.value }
  public get hoveredKey(): string | null { return this.hoveredRowKey.value }
  public get selected(): boolean { return this.selectedAgentId.value !== null }
  public get isPopoverOpen(): boolean { return this.activeRowValue?.value !== null && this.activeRowValue?.value !== undefined }
  public get ready(): boolean { return this.popoverReady.value }
  public get popoverId(): string { return `worker-chart-${this.sources.instanceId}-popover` }
  public get activePopoverAgent(): WorkerChartAgent | null {
    return this.activeRowValue?.value?.agent ?? null;
  }

  public mount(): void {
    document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.addEventListener('keydown', this.onDocumentKeyDown, true);
    window.addEventListener('resize', this.onWindowResize);
  }

  public unmount(): void {
    if (this.tooltipCloseTimer) clearTimeout(this.tooltipCloseTimer);
    this.stopWatches.forEach(stop => stop());
    document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
    window.removeEventListener('resize', this.onWindowResize);
  }

  public registerButton(key: string, element: HTMLButtonElement | null): void {
    if (element) this.nodeButtons.set(key, element);
    else this.nodeButtons.delete(key);
  }

  public button(key: string): HTMLButtonElement | undefined { return this.nodeButtons.get(key) }
  public registerPopover(element: HTMLElement | null): void { this.popover.value = element }

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

  public onNodeBlur(event: FocusEvent): void {
    if (this.selectedAgentId.value) return;
    if (event.relatedTarget instanceof Node && this.popover.value?.contains(event.relatedTarget)) return;
    this.scheduleTooltipClose();
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

  public toggleAgentPopover(id: string): void {
    if (this.selectedAgentId.value === id) {
      this.dismissPopover(true);
      return;
    }
    this.selectedAgentId.value = id;
    this.hoveredRowKey.value = null;
    void nextTick(() => (this.popover.value ?? document.getElementById(this.popoverId))?.focus({ preventScroll: true }));
  }

  public openAgent(agentId: string): void {
    this.sources.openAgent({ agentId });
    this.dismissPopover(true);
  }

  public dismissPopover(restoreFocus: boolean, fallback = false): void {
    const oldKey = this.selectedAgentId.value ?? this.hoveredRowKey.value;
    this.selectedAgentId.value = null;
    this.hoveredRowKey.value = null;
    this.popoverReady.value = false;
    if (!restoreFocus) return;
    void nextTick(() => {
      const trigger = oldKey ? this.nodeButtons.get(oldKey) : null;
      if (trigger?.isConnected && !fallback) { this.focusWithoutTooltip(trigger); return }
      if (this.isNarrow && this.railTrigger.value?.isConnected) { this.focusWithoutTooltip(this.railTrigger.value); return }
      const first = this.rows[0];
      const firstButton = first ? this.nodeButtons.get(first.key) : null;
      if (firstButton?.isConnected) this.focusWithoutTooltip(firstButton);
      else if (this.host.value) { this.host.value.tabIndex = -1; this.focusWithoutTooltip(this.host.value) }
    });
  }

  public repositionPopover(): void {
    const row = this.activeRowValue?.value;
    if (row) void this.positionPopover(row.key);
  }

  private focusWithoutTooltip(element: HTMLElement | null): void {
    if (!element?.isConnected) return;
    this.suppressTooltipOnFocus = true;
    try { element.focus({ preventScroll: true }) }
    finally { this.suppressTooltipOnFocus = false }
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
}
