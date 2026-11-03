// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * DOM helpers for the model routing lists: FLIP reorder animation, pointer
 * drag with live reflow (rows slide apart to show the drop position) and
 * popover placement. Rows must carry a `data-key` attribute.
 */

import { nextTick } from 'vue';

const EASE_MOVE = 'cubic-bezier(.22,1,.36,1)';
const EASE_ENTER = 'cubic-bezier(.16,1,.3,1)';
const EASE_EXIT = 'cubic-bezier(.7,0,.84,0)';

export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function rowsOf(container: HTMLElement | null | undefined, selector: string): HTMLElement[] {
  return container ? [...container.querySelectorAll<HTMLElement>(selector)] : [];
}

export function rowByKey(container: HTMLElement | null | undefined, selector: string, key: string): HTMLElement | undefined {
  return rowsOf(container, selector).find(el => el.dataset.key === key);
}

/** Run `mutate` (a state change), wait for Vue to patch, then slide every row from its old spot to its new one. */
export async function flip(container: HTMLElement | null | undefined, selector: string, mutate: () => void): Promise<void> {
  const before = new Map(rowsOf(container, selector).map(el => [el.dataset.key, el.getBoundingClientRect().top]));
  mutate();
  await nextTick();
  if (reducedMotion()) return;
  for (const el of rowsOf(container, selector)) {
    const was = before.get(el.dataset.key);
    if (was === undefined) continue;
    const dy = was - el.getBoundingClientRect().top;
    if (dy) el.animate([{ transform: `translateY(${ dy }px)` }, { transform: 'none' }], { duration: 480, easing: EASE_MOVE });
  }
}

export function animateIn(el: HTMLElement | null | undefined): void {
  if (!el || reducedMotion()) return;
  el.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 480, easing: EASE_ENTER });
}

/** Fade a row out to the right, then resolve (the caller removes it). */
export async function animateOut(el: HTMLElement | null | undefined): Promise<void> {
  if (!el || reducedMotion()) return;
  el.style.pointerEvents = 'none';
  await el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(12px)' }], { duration: 160, easing: EASE_EXIT, fill: 'forwards' }).finished.catch(() => undefined);
}

export function nudge(el: HTMLElement | null | undefined): void {
  if (!el || reducedMotion()) return;
  el.animate([{ opacity: 0, transform: 'translateX(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: EASE_ENTER });
}

/**
 * Pointer drag on a grip. The dragged row follows the pointer (clamped to the list, slight tilt),
 * the rows it passes slide out of the way to open the drop slot, and on release `onDrop(from, to)`
 * commits the move. The dropped row then settles into place.
 */
export function startDrag(e: PointerEvent, opts: { list: HTMLElement; selector: string; onDrop: (from: number, to: number) => void }): void {
  const grip = e.currentTarget as HTMLElement | null;
  const row = grip?.closest<HTMLElement>(opts.selector);
  if (!grip || !row || e.button !== 0) return;
  const rows = rowsOf(opts.list, opts.selector);
  const from = rows.indexOf(row);
  if (from < 0 || rows.length < 2) return;
  const rects = rows.map(r => r.getBoundingClientRect());
  const h = rects[from].height; const y0 = e.clientY; let to = from;

  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  row.classList.add('drag'); opts.list.classList.add('dragging');

  const move = (ev: PointerEvent) => {
    const dy = ev.clientY - y0;
    const cy = Math.max(rects[0].top - rects[from].top, Math.min(rects[rects.length - 1].top - rects[from].top, dy));
    const tilt = Math.max(-1.2, Math.min(1.2, (dy - cy) / 40 + (dy > 0 ? .6 : -.6)));
    row.style.transform = `translateY(${ cy }px) rotate(${ tilt }deg) scale(1.01)`;
    const mid = rects[from].top + h / 2 + cy;
    to = from;
    rects.forEach((r, i) => { if (i < from && mid < r.top + r.height / 2) to = Math.min(to, i); if (i > from && mid > r.top + r.height / 2) to = i; });
    rows.forEach((r, i) => {
      if (i === from) return;
      let shift = 0;
      if (from < to && i > from && i <= to) shift = -h;
      if (from > to && i >= to && i < from) shift = h;
      r.style.transform = shift ? `translateY(${ shift }px)` : '';
    });
  };
  const end = async() => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', end);
    grip.removeEventListener('pointercancel', end);
    const key = row.dataset.key ?? ''; const top = row.getBoundingClientRect().top;
    rows.forEach((r) => { r.style.transform = ''; });
    row.classList.remove('drag'); opts.list.classList.remove('dragging');
    if (from !== to) opts.onDrop(from, to);
    await nextTick();
    const el = rowByKey(opts.list, opts.selector, key);
    if (el && !reducedMotion()) el.animate([{ transform: `translateY(${ top - el.getBoundingClientRect().top }px) scale(1.01)` }, { transform: 'none' }], { duration: 480, easing: EASE_ENTER });
    el?.querySelector<HTMLElement>('.mr-grip')?.focus({ preventScroll: true });
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
}

/** Place a popover (absolutely positioned inside `root`) under its anchor, or above it when there's more room. */
export function placePopover(pop: HTMLElement, anchor: HTMLElement, root: HTMLElement): void {
  const r = anchor.getBoundingClientRect(); const rr = root.getBoundingClientRect();
  const below = window.innerHeight - r.bottom - 16; const above = r.top - 16; const up = below < 260 && above > below;
  const body = pop.querySelector<HTMLElement>('.mr-pk-b');
  if (body) body.style.maxHeight = `${ Math.max(140, Math.min(380, up ? above : below) - 54) }px`;
  const w = pop.offsetWidth;
  const left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12));
  pop.style.left = `${ left - rr.left }px`;
  pop.style.top = `${ up ? r.top - rr.top - 6 - pop.offsetHeight : r.bottom - rr.top + 6 }px`;
}
