export interface ActiveTabIndicatorMetrics {
  x:     number;
  width: number;
}

export function isTabCloseable(pinned: boolean, supportsClose = true): boolean {
  return supportsClose && !pinned;
}

export function measureActiveTabIndicator(container: HTMLElement): ActiveTabIndicatorMetrics | null {
  const active = container.querySelector<HTMLElement>('.tab-item[data-active="true"]');

  if (!active) return null;

  return {
    x:     active.offsetLeft,
    width: active.offsetWidth,
  };
}
