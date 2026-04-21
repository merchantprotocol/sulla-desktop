// GuestBridge.ts — Thin main-process wrapper around a tab's WebContents.
//
// The guest preload (browserTabPreload.ts → GuestBridgePreload) installs
// `window.sullaBridge` at document-start on every page load. That global
// exposes DOM helpers (click, setValue, getActionableMarkdown, etc.).
//
// This class is a typed shim: each method becomes one `executeJavaScript`
// round-trip. There is no state machine, no readiness probe, no IPC hop.
// If the page's `window.sullaBridge` is missing (a rare edge case — e.g.
// the page wiped globals, which we haven't seen happen), the call returns
// undefined and the tool decides what to do.
//
// CDP-based methods (screenshot, trusted mouse/keyboard events) use
// `webContents` APIs directly — no guest-side code needed.

import type { WebContents } from 'electron';

function jsArg(value: unknown): string {
  return JSON.stringify(value);
}

export class GuestBridge {
  constructor(private readonly wc: WebContents, public readonly assetId: string) {}

  /** Raw JS eval in the guest page. Used by execInPage tool + internal helpers. */
  async exec(code: string): Promise<unknown> {
    try {
      return await this.wc.executeJavaScript(code, true);
    } catch {
      return undefined;
    }
  }

  private call(method: string, ...args: unknown[]): Promise<unknown> {
    const argList = args.map(jsArg).join(',');
    return this.exec(`window.sullaBridge && window.sullaBridge.${ method }(${ argList })`);
  }

  // ── Page info (native, no guest bridge needed) ────────────────────
  async getPageTitle(): Promise<string> {
    return String((await this.exec('document.title')) || '');
  }

  async getPageUrl(): Promise<string> {
    return String((await this.exec('location.href')) || '');
  }

  async getPageHtml(): Promise<string> {
    return String((await this.exec('document.documentElement.outerHTML')) || '');
  }

  execInPage(code: string): Promise<unknown> {
    return this.exec(code);
  }

  // ── Guest bridge methods (DOM helpers from window.sullaBridge) ────
  async getActionableMarkdown(): Promise<string> {
    return String((await this.call('getActionableMarkdown')) || '');
  }

  async getPageText(): Promise<string> {
    return String((await this.call('getPageText')) || '');
  }

  async click(handle: string): Promise<boolean> {
    return !!(await this.call('click', handle));
  }

  async setValue(handle: string, value: string): Promise<boolean> {
    return !!(await this.call('setValue', handle, value));
  }

  async getFormValues(): Promise<Record<string, string>> {
    const result = await this.call('getFormValues');
    return (result && typeof result === 'object' && !Array.isArray(result))
      ? result as Record<string, string>
      : {};
  }

  async scrollTo(selector: string): Promise<boolean> {
    return !!(await this.call('scrollTo', selector));
  }

  async waitForSelector(selector: string, timeoutMs = 5000): Promise<boolean> {
    // waitForSelector polls inside the guest; the guest owns the timeout.
    return !!(await this.call('waitForSelector', selector, timeoutMs));
  }

  async getReaderContent(maxChars?: number): Promise<{
    title: string; url: string; content: string; contentLength: number; truncated: boolean;
  } | null> {
    const result = await (maxChars !== undefined ? this.call('getReaderContent', maxChars) : this.call('getReaderContent'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
    const r = result as Record<string, unknown>;
    return {
      title:         String(r.title || ''),
      url:           String(r.url || ''),
      content:       String(r.content || ''),
      contentLength: Number(r.contentLength) || 0,
      truncated:     r.truncated === true,
    };
  }

  async getScrollInfo(): Promise<{
    scrollY: number; scrollHeight: number; viewportHeight: number; percent: number;
    atTop: boolean; atBottom: boolean; moreBelow: boolean; moreAbove: boolean;
  }> {
    const result = await this.call('getScrollInfo');
    const r = (result && typeof result === 'object') ? result as Record<string, unknown> : {};
    return {
      scrollY:        Number(r.scrollY) || 0,
      scrollHeight:   Number(r.scrollHeight) || 0,
      viewportHeight: Number(r.viewportHeight) || 0,
      percent:        Number(r.percent) || 0,
      atTop:          r.atTop === true,
      atBottom:       r.atBottom === true,
      moreBelow:      r.moreBelow === true,
      moreAbove:      r.moreAbove === true,
    };
  }

  async scrollAndCapture(direction: 'up' | 'down' = 'down'): Promise<{
    newContent: string; scrollInfo: Record<string, unknown>; noNewContent: boolean;
  }> {
    const result = await this.call('scrollAndCapture', direction);
    const r = (result && typeof result === 'object') ? result as Record<string, unknown> : {};
    return {
      newContent:   String(r.newContent || ''),
      scrollInfo:   (r.scrollInfo && typeof r.scrollInfo === 'object') ? r.scrollInfo as Record<string, unknown> : {},
      noNewContent: r.noNewContent === true,
    };
  }

  async scrollToTop(): Promise<Record<string, unknown>> {
    const result = await this.call('scrollToTop');
    return (result && typeof result === 'object') ? result as Record<string, unknown> : {};
  }

  async searchInPage(query: string): Promise<{ matches: { index: number; context: string }[]; total: number; query: string }> {
    const result = await this.call('searchInPage', query);
    const r = (result && typeof result === 'object') ? result as Record<string, unknown> : {};
    return {
      matches: Array.isArray(r.matches) ? r.matches as { index: number; context: string }[] : [],
      total:   Number(r.total) || 0,
      query:   String(r.query || query),
    };
  }

  async annotateElements(): Promise<{ index: number; label: string; x: number; y: number; width: number; height: number }[]> {
    const result = await this.exec(`
      (function() {
        document.querySelectorAll('[data-sulla-annotation]').forEach(el => el.remove());
        const interactive = document.querySelectorAll('a, button, input, textarea, select, [role="button"], [tabindex], [onclick]');
        const results = [];
        let index = 1;
        for (const el of interactive) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.top > window.innerHeight || rect.bottom < 0) continue;
          const label = el.textContent?.trim().slice(0, 30) || el.getAttribute('aria-label') || el.tagName.toLowerCase();
          results.push({ index, label, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), width: Math.round(rect.width), height: Math.round(rect.height) });
          index++;
          if (index > 50) break;
        }
        return results;
      })()
    `);
    return Array.isArray(result) ? result as any[] : [];
  }

  async removeAnnotations(): Promise<void> {
    await this.exec(`document.querySelectorAll('[data-sulla-annotation]').forEach(el => el.remove())`);
  }

  // ── CDP / native input (screenshot, trusted events) ──────────────
  async captureScreenshot(options: {
    format?: 'jpeg' | 'png'; quality?: number; clip?: { x: number; y: number; width: number; height: number };
  } = {}): Promise<{ base64: string; mediaType: string } | null> {
    try {
      const image = options.clip
        ? await this.wc.capturePage(options.clip)
        : await this.wc.capturePage();
      const format = options.format === 'png' ? 'png' : 'jpeg';
      const quality = typeof options.quality === 'number' ? options.quality : 80;
      const buf = format === 'png' ? image.toPNG() : image.toJPEG(quality);
      return { base64: buf.toString('base64'), mediaType: `image/${ format }` };
    } catch {
      return null;
    }
  }

  async moveMouse(x: number, y: number): Promise<boolean> {
    try {
      this.wc.sendInputEvent({ type: 'mouseMove', x, y } as any);
      return true;
    } catch {
      return false;
    }
  }

  async clickAtCoordinate(x: number, y: number, options: { button?: 'left' | 'right' | 'middle'; clickCount?: number } = {}): Promise<boolean> {
    try {
      const button = options.button ?? 'left';
      const clickCount = options.clickCount ?? 1;
      this.wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount } as any);
      this.wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount } as any);
      return true;
    } catch {
      return false;
    }
  }

  async dragFromTo(fromX: number, fromY: number, toX: number, toY: number): Promise<boolean> {
    try {
      this.wc.sendInputEvent({ type: 'mouseDown', x: fromX, y: fromY, button: 'left' } as any);
      const steps = 10;
      for (let i = 1; i <= steps; i++) {
        const mx = fromX + (toX - fromX) * (i / steps);
        const my = fromY + (toY - fromY) * (i / steps);
        this.wc.sendInputEvent({ type: 'mouseMove', x: mx, y: my, button: 'left' } as any);
      }
      this.wc.sendInputEvent({ type: 'mouseUp', x: toX, y: toY, button: 'left' } as any);
      return true;
    } catch {
      return false;
    }
  }

  async scrollAtCoordinate(_x: number, _y: number, deltaX: number, deltaY: number): Promise<boolean> {
    await this.exec(`window.scrollBy(${ deltaX }, ${ deltaY })`);
    return true;
  }

  async typeText(text: string): Promise<boolean> {
    try {
      for (const ch of text) {
        this.wc.sendInputEvent({ type: 'keyDown', keyCode: ch } as any);
        this.wc.sendInputEvent({ type: 'char', keyCode: ch } as any);
        this.wc.sendInputEvent({ type: 'keyUp', keyCode: ch } as any);
      }
      return true;
    } catch {
      return false;
    }
  }

  async pressKey(key: string, handle?: string): Promise<boolean> {
    if (handle) {
      await this.call('focusElement', handle);
    }
    try {
      this.wc.sendInputEvent({ type: 'keyDown', keyCode: key } as any);
      if (key.length === 1 || key === 'Enter' || key === 'Space' || key === 'Tab') {
        this.wc.sendInputEvent({ type: 'char', keyCode: key } as any);
      }
      this.wc.sendInputEvent({ type: 'keyUp', keyCode: key } as any);
      return true;
    } catch {
      return !!(await this.call('pressKey', key, handle));
    }
  }
}
