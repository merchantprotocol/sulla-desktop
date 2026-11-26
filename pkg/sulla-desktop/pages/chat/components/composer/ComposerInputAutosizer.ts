// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface ComposerInputResizeObserver {
  observe(target: Element): void;
  disconnect(): void;
}

export type ComposerInputResizeObserverFactory = (callback: ResizeObserverCallback) => ComposerInputResizeObserver;

export class ComposerInputAutosizer {
  private observer: ComposerInputResizeObserver | undefined;
  private lastObservedWidth = 0;
  private disposed = false;

  constructor(
    private readonly element: HTMLTextAreaElement,
    private readonly observerFactory?: ComposerInputResizeObserverFactory,
    private readonly fontsReady: Promise<unknown> = typeof document === 'undefined' ? Promise.resolve() : document.fonts?.ready ?? Promise.resolve(),
  ) {}

  observe(): void {
    this.resize();
    if (this.observerFactory || typeof ResizeObserver !== 'undefined') {
      const factory = this.observerFactory ?? ((callback: ResizeObserverCallback) => new ResizeObserver(callback));
      this.observer = factory(entries => this.onResize(entries));
      this.observer.observe(this.element);
    }
    void this.fontsReady.then(() => this.resize(), () => this.resize());
  }

  resize(): void {
    if (this.disposed || this.element.getBoundingClientRect().width <= 0) return;
    this.element.style.overflowY = 'hidden';
    this.element.style.height = 'auto';
    const borderHeight = this.element.offsetHeight - this.element.clientHeight;
    const contentHeight = this.element.scrollHeight;
    this.element.style.height = Math.min(160, contentHeight + borderHeight) + 'px';
    this.element.style.overflowY = contentHeight > this.element.clientHeight ? 'auto' : 'hidden';
  }

  dispose(): void {
    this.disposed = true;
    this.observer?.disconnect();
    this.observer = undefined;
  }

  private onResize(entries: readonly ResizeObserverEntry[]): void {
    const width = entries.find(entry => entry.target === this.element)?.contentRect.width ?? 0;
    if (width <= 0) { this.lastObservedWidth = 0; return; }
    if (width === this.lastObservedWidth) return;
    this.lastObservedWidth = width;
    this.resize();
  }
}
