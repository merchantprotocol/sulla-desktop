// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Runs a script in the page's main world as the embedder (e.g. webFrame.executeJavaScript). */
export type EmbedderScriptExecutor = (script: string) => Promise<unknown>;

export interface InjectorLog {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * Installs the guest bridge into a browser tab without page-level eval.
 *
 * The tab preload shares the page's main world (contextIsolation is off), so
 * eval/new Function there is governed by the page's CSP and fails on every
 * site that omits 'unsafe-eval'. The executor is the embedder path, which CSP
 * does not apply to. A failed injection is logged with the reason and never
 * thrown: the page must keep loading even when the bridge cannot be installed.
 */
export class GuestBridgeInjector {
  constructor(
    private readonly execute: EmbedderScriptExecutor,
    private readonly output: InjectorLog,
    private readonly logPrefix: string,
  ) {}

  async inject(script: string, url: string): Promise<boolean> {
    try {
      await this.execute(script);
      this.output.log(`${ this.logPrefix } guest bridge injected`, { url });

      return true;
    } catch (err) {
      this.output.error(`${ this.logPrefix } guest bridge injection failed`, { url, err });

      return false;
    }
  }
}
