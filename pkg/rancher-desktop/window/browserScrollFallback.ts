export interface RootScrollFallbackState {
  hasInnerScrollableTarget: boolean;
  rootScrollTop: number;
  rootMaxScrollTop: number;
  deltaY: number;
  defaultPrevented: boolean;
}

/**
 * Returns whether a wheel gesture should be replayed against the document
 * root after Chromium failed to move it natively.
 *
 * Inner overflow nodes are deliberately excluded. Their native scroll path
 * already works and replaying the gesture at the root would scroll two
 * surfaces at once.
 */
export function shouldFallbackToRootScroll(state: RootScrollFallbackState): boolean {
  if (state.defaultPrevented || state.hasInnerScrollableTarget || Math.abs(state.deltaY) < 1) return false;

  return state.deltaY > 0
    ? state.rootScrollTop < state.rootMaxScrollTop - 1
    : state.rootScrollTop > 1;
}
