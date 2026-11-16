// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createApp, type App as VueApp } from 'vue';
import FilesBrowser from '../../../pkg/sulla-desktop/pages/files/FilesBrowser.vue';
import { BrowserFilesDataSource, type ContainerCollection } from './BrowserFilesDataSource';
import './shell.css';

/** Hosts the Files browser inside the Sulla Server service iframe; one instance per page. */
class FilesWebShell {
  private readonly service = 'files';
  private application: VueApp | undefined;
  private dataSource: BrowserFilesDataSource | undefined;
  private generation = 0;
  private lastActivity = 0;

  constructor(
    private readonly origin: string,
    private readonly status: HTMLElement,
    private readonly bar: HTMLElement,
    private readonly select: HTMLSelectElement,
  ) {}

  start(): void {
    window.addEventListener('message', event => this.onMessage(event));
    for (const event of ['pointerdown', 'keydown', 'scroll']) window.addEventListener(event, () => this.reportActivity(), { passive: true });
    window.addEventListener('pagehide', () => this.clear());
    this.post('sulla.service.ready');
  }

  private post(type: string): void {
    window.parent.postMessage({ type, version: 1, service: this.service }, this.origin);
  }

  private reportActivity(): void {
    const now = Date.now();
    if (now - this.lastActivity < 30_000) return;
    this.lastActivity = now;
    this.post('sulla.service.activity');
  }

  private clear(): void {
    this.generation += 1;
    this.application?.unmount();
    this.application = undefined;
    this.dataSource?.destroy();
    this.dataSource = undefined;
    this.select.replaceChildren();
    this.bar.hidden = true;
    document.getElementById('app')!.replaceChildren();
    this.status.hidden = false;
    this.status.textContent = 'Waiting for your Sulla Server session…';
  }

  private renderCollection(source: BrowserFilesDataSource, collection: ContainerCollection): void {
    this.application?.unmount();
    document.getElementById('app')!.replaceChildren();
    source.selectCollection(collection);
    this.application = createApp(FilesBrowser, { dataSource: source, tabId: 'server-files-explorer' });
    this.application.mount('#app');
    this.bar.hidden = true;
    this.status.hidden = true;
  }

  private async mount(token: string, accountName: string, orgId: string): Promise<void> {
    this.clear();
    const active = this.generation;
    const apiBase = window.location.pathname.startsWith('/services/files/') ? '/services/files/api' : window.location.pathname.startsWith('/files-proof/') ? '' : undefined;
    const source = new BrowserFilesDataSource(token, accountName, orgId, () => {
      if (active !== this.generation) return;
      this.clear();
      this.post('sulla.service.expired');
    }, apiBase);
    this.dataSource = source;
    this.status.textContent = 'Loading your Files collections…';
    try {
      const collections = await source.availableCollections();
      if (active !== this.generation) return;
      if (collections.length === 1) {
        this.renderCollection(source, collections[0]);
        return;
      }
      const prompt = document.createElement('option');
      prompt.value = '';
      prompt.textContent = 'Choose a collection…';
      this.select.replaceChildren(prompt, ...collections.map(collection => {
        const option = document.createElement('option');
        option.value = collection.id;
        option.textContent = `${collection.name} · ${collection.access_role ?? 'shared'}`;
        return option;
      }));
      this.bar.hidden = false;
      this.status.textContent = 'Choose a Files collection to continue.';
      this.select.onchange = () => {
        const collection = collections.find(value => value.id === this.select.value);
        if (collection) this.renderCollection(source, collection);
      };
    } catch (error) {
      if (active !== this.generation) return;
      this.status.hidden = false;
      this.status.textContent = error instanceof Error ? error.message : 'Files is unavailable.';
    }
  }

  private onMessage(event: MessageEvent): void {
    if (event.origin !== this.origin || event.source !== window.parent) return;
    const message = event.data;
    if (message?.version !== 1 || message.service !== this.service) return;
    if (message.type === 'sulla.service.session' && typeof message.token === 'string' && message.token && typeof message.organizationId === 'string' && message.organizationId) {
      void this.mount(message.token, typeof message.email === 'string' ? message.email : 'Server member', message.organizationId);
    }
    if (message.type === 'sulla.service.lock') this.clear();
  }
}

new FilesWebShell(
  window.location.origin,
  document.getElementById('status')!,
  document.getElementById('collection-bar')!,
  document.getElementById('collection-select') as HTMLSelectElement,
).start();
