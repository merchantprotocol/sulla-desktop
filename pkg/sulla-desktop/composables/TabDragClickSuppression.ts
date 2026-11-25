// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Swallows only the pointer click synthesized by the just-completed drag. */
export class TabDragClickSuppression {
  private release?: () => void;

  constructor(private readonly target: Pick<Window, 'addEventListener' | 'removeEventListener' | 'setTimeout' | 'clearTimeout'>) {}

  arm(anchor: EventTarget, pointerId: number, awaitRelease = false): void {
    this.cancel();
    let timer: number | undefined;
    let released = !awaitRelease;
    const clear = () => this.cancel();
    const expire = () => { timer = this.target.setTimeout(clear, 300) };
    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      this.target.removeEventListener('pointerup', onUp, true);
      released = true;
      expire();
    };
    const onCancel = (event: PointerEvent) => {
      if (event.pointerId === pointerId) clear();
    };
    const onClick = (event: MouseEvent) => {
      const eventPointer = (event as PointerEvent).pointerId;

      if (!released || event.button !== 0 || event.detail === 0 ||
          (typeof eventPointer === 'number' && eventPointer !== pointerId) ||
          !event.composedPath().includes(anchor)) return;
      clear();
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    this.release = () => {
      if (timer !== undefined) this.target.clearTimeout(timer);
      this.target.removeEventListener('pointerdown', clear, true);
      this.target.removeEventListener('pointerup', onUp, true);
      this.target.removeEventListener('pointercancel', onCancel, true);
      this.target.removeEventListener('click', onClick, true);
      this.target.removeEventListener('blur', clear);
    };
    this.target.addEventListener('pointerdown', clear, true);
    this.target.addEventListener('pointercancel', onCancel, true);
    this.target.addEventListener('click', onClick, true);
    this.target.addEventListener('blur', clear);
    if (awaitRelease) this.target.addEventListener('pointerup', onUp, true);
    else expire();
  }

  cancel(): void {
    const release = this.release;

    this.release = undefined;
    release?.();
  }
}
