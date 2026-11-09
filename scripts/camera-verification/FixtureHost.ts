// SPDX-License-Identifier: GPL-2.0-or-later
import type { App } from 'vue';

/** Observes real menu props; retained actions are used ONLY to verify stale-action refusal. */
export class FixtureHost {
  private staleAction?: () => void;
  private recording = false;
  private readonly ipc = require('electron').ipcRenderer;

  async install(app: App): Promise<void> {
    const observer = this;
    app.config.errorHandler = error => this.ipc.send('ce1:failure', String(error));
    app.mixin({
      mounted() { observer.observe(this.$props); },
      updated() { observer.observe(this.$props); },
    });
    this.ipc.on('ce1:stale-action', () => {
      if (!this.staleAction) throw new Error('No captured actual menu action');
      this.recording = true;
      this.staleAction();
      this.ipc.send('ce1:stale-invoked');
    });
  }

  private observe(props: any): void {
    if (!props.visible || !Array.isArray(props.items) || this.recording) return;
    const item = props.items.find((item: any) => item.id === 'effect-framing');
    if (item && !item.disabled) this.staleAction = item.action;
  }
}
