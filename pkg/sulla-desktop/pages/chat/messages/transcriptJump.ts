// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** A transcript line as the transcript lists it: one message, or a work block holding several. */
interface JumpEntry { id: string; sourceId?: string; messages?: readonly { id: string }[] }

/**
 * "Jump to" (side dock, status line, quick switcher): one transcript keeps each
 * shown line's element, finds the line holding a message, scrolls it to the
 * middle and briefly outlines it. A message folded into a work block jumps to
 * that block.
 */
export class TranscriptJump {
  private readonly lines = new Map<string, Element>();

  /** Called from a template ref: an element, or a component whose root is the line. */
  register(id: string, ref: unknown): void {
    const el = TranscriptJump.elementOf(ref);
    if (el) this.lines.set(id, el);
    else this.lines.delete(id);
  }

  /** True when this transcript showed the message. */
  jump(entries: readonly JumpEntry[], messageId: string, reduceMotion: boolean): boolean {
    const entry = entries.find(item => item.id === messageId || item.sourceId === messageId || item.messages?.some(message => message.id === messageId));
    const el = entry && this.lines.get(entry.id);
    if (!el?.isConnected) return false;
    el.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    if (!reduceMotion) {
      el.animate(
        [{ boxShadow: '0 0 0 2px var(--accent)', borderRadius: '10px' }, { boxShadow: '0 0 0 2px transparent', borderRadius: '10px' }],
        { duration: 1800, easing: 'cubic-bezier(.22, 1, .36, 1)' },
      );
    }
    return true;
  }

  /** A component's root, skipping the text anchor a fragment root starts with. */
  private static elementOf(ref: unknown): Element | null {
    let node = (ref && typeof ref === 'object' && '$el' in ref ? (ref as { $el: unknown }).$el : ref) as Node | null;
    while (node && node.nodeType !== 1) node = node.nextSibling;
    return node as Element | null;
  }
}
