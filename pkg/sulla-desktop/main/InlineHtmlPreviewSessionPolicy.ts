// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { BlockList, isIP } from 'node:net';
import { createHash } from 'node:crypto';

import type { App, Event as ElectronEvent, Session, WebContents, WebPreferences } from 'electron';

const WEB_PREFERENCES = {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  disableDialogs: true,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  allowRunningInsecureContent: false,
  webviewTag: false,
  devTools: false,
} as const;
const WEB_PREFERENCES_ATTRIBUTE = 'nodeIntegration=no,contextIsolation=yes,sandbox=yes,webSecurity=yes,disableDialogs=yes,nodeIntegrationInSubFrames=no,nodeIntegrationInWorker=no';
const LINK_WINDOW_MS = 60_000;
const LINK_LIMIT_PER_WINDOW = 5;

/** Main-process security policy for the dedicated chat HTML guest session. */
export class InlineHtmlPreviewSessionPolicy {
  private readonly blockedNetworks = new BlockList();
  private readonly recentLinkOpens: number[] = [];
  private readonly initialDataUrls = new Map<string, { count: number; expiresAt: number }>();
  private installed = false;

  constructor(
    private readonly session: Session,
    private readonly application: App,
    private readonly openUrlInApp: (url: string) => void,
    private readonly isAllowedCapabilityOrigin: (url: URL) => boolean,
    private readonly partition: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.blockedNetworks.addSubnet('0.0.0.0', 8, 'ipv4');
    this.blockedNetworks.addSubnet('10.0.0.0', 8, 'ipv4');
    this.blockedNetworks.addSubnet('100.64.0.0', 10, 'ipv4');
    this.blockedNetworks.addSubnet('127.0.0.0', 8, 'ipv4');
    this.blockedNetworks.addSubnet('169.254.0.0', 16, 'ipv4');
    this.blockedNetworks.addSubnet('172.16.0.0', 12, 'ipv4');
    this.blockedNetworks.addSubnet('192.0.0.0', 24, 'ipv4');
    this.blockedNetworks.addSubnet('192.0.2.0', 24, 'ipv4');
    this.blockedNetworks.addSubnet('192.168.0.0', 16, 'ipv4');
    this.blockedNetworks.addSubnet('198.18.0.0', 15, 'ipv4');
    this.blockedNetworks.addSubnet('198.51.100.0', 24, 'ipv4');
    this.blockedNetworks.addSubnet('203.0.113.0', 24, 'ipv4');
    this.blockedNetworks.addSubnet('224.0.0.0', 4, 'ipv4');
    this.blockedNetworks.addSubnet('240.0.0.0', 4, 'ipv4');
    this.blockedNetworks.addSubnet('::', 96, 'ipv6');
    this.blockedNetworks.addSubnet('64:ff9b::', 96, 'ipv6');
    this.blockedNetworks.addSubnet('64:ff9b:1::', 48, 'ipv6');
    this.blockedNetworks.addSubnet('100::', 64, 'ipv6');
    this.blockedNetworks.addSubnet('2001:db8::', 32, 'ipv6');
    this.blockedNetworks.addSubnet('2001::', 23, 'ipv6');
    this.blockedNetworks.addSubnet('2002::', 16, 'ipv6');
    this.blockedNetworks.addSubnet('fc00::', 7, 'ipv6');
    this.blockedNetworks.addSubnet('fec0::', 10, 'ipv6');
    this.blockedNetworks.addSubnet('fe80::', 10, 'ipv6');
    this.blockedNetworks.addSubnet('ff00::', 8, 'ipv6');
  }

  install(): void {
    if (this.installed) return;
    this.installed = true;

    this.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.session.setPermissionCheckHandler(() => false);
    this.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      void this.shouldBlockRequest(details.url)
        .then(cancel => callback({ cancel }))
        .catch(() => callback({ cancel: true }));
    });

    this.application.on('web-contents-created', (_event: ElectronEvent, contents: WebContents) => {
      contents.on('will-attach-webview', (event, webPreferences, params) => this.onWillAttachWebview(event, webPreferences, params));
      if (contents.session === this.session) this.protectPreviewContents(contents);
    });
  }

  private onWillAttachWebview(event: ElectronEvent, preferences: WebPreferences, params: Record<string, string>): void {
    const requestedPartition = params.partition || preferences.partition;
    const source = params.src || '';
    const isPreviewGuest = requestedPartition === this.partition || this.isPreviewIntentSource(source);
    // webviewTag is also enabled for other trusted app surfaces. Only take
    // ownership of the dedicated HTML-preview guest (and obvious attempts to
    // load one outside its partition); unrelated app webviews keep their own
    // existing policy.
    if (!isPreviewGuest) return;

    const hasPopups = Object.prototype.hasOwnProperty.call(params, 'allowpopups');
    const isUnsafe = preferences.nodeIntegration === true
      || preferences.contextIsolation === false
      || preferences.sandbox === false
      || preferences.webSecurity === false
      || preferences.disableDialogs === false
      || preferences.nodeIntegrationInSubFrames === true
      || preferences.nodeIntegrationInWorker === true
      || preferences.allowRunningInsecureContent === true
      || preferences.webviewTag === true
      || preferences.devTools === true
      || Boolean(preferences.preload || params.preload)
      || hasPopups
      || !this.isAllowedInitialSource(source);

    if (requestedPartition !== this.partition || isUnsafe) {
      event.preventDefault();
    }

    // Do not rely on renderer-supplied attributes even when rejecting this
    // attachment: every accepted guest is pinned to these exact preferences.
    Object.assign(preferences, WEB_PREFERENCES, { partition: this.partition });
    delete preferences.preload;
    params.partition = this.partition;
    params.webpreferences = WEB_PREFERENCES_ATTRIBUTE;
    delete params.allowpopups;
    delete params.preload;

    if (/^data:text\/html(?:;|,)/i.test(source)) this.addInitialDataUrl(source);
  }

  private isAllowedInitialSource(source: string): boolean {
    if (/^data:text\/html(?:;|,)/i.test(source)) return true;
    return this.isAllowedPreviewUrl(source);
  }

  private isPreviewIntentSource(source: string): boolean {
    return /^data:text\/html(?:;|,)/i.test(source) || /^sulla-files-preview:/i.test(source);
  }

  private protectPreviewContents(contents: WebContents): void {
    contents.setWindowOpenHandler(details => {
      void this.routeExternalLink(details.url).catch(() => undefined);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (this.isAllowedPreviewUrl(url) || this.consumeInitialDataUrl(url)) return;
      event.preventDefault();
      void this.routeExternalLink(url).catch(() => undefined);
    });
  }

  private addInitialDataUrl(url: string): void {
    this.pruneInitialDataUrls();
    const digest = this.hashDataUrl(url);
    const current = this.initialDataUrls.get(digest);
    this.initialDataUrls.set(digest, { count: (current?.count ?? 0) + 1, expiresAt: this.now() + 10_000 });
  }

  private consumeInitialDataUrl(url: string): boolean {
    this.pruneInitialDataUrls();
    const digest = this.hashDataUrl(url);
    const entry = this.initialDataUrls.get(digest);
    if (!entry) return false;
    if (entry.count === 1) this.initialDataUrls.delete(digest);
    else this.initialDataUrls.set(digest, { ...entry, count: entry.count - 1 });
    return true;
  }

  private pruneInitialDataUrls(): void {
    const now = this.now();
    for (const [digest, entry] of this.initialDataUrls) {
      if (entry.expiresAt <= now) this.initialDataUrls.delete(digest);
    }
  }

  private hashDataUrl(url: string): string {
    return createHash('sha256').update(url).digest('hex');
  }

  private isAllowedPreviewUrl(candidate: string): boolean {
    try {
      const url = new URL(candidate);
      return url.protocol === 'sulla-files-preview:' && this.isAllowedCapabilityOrigin(url);
    } catch {
      return false;
    }
  }

  private async shouldBlockRequest(candidate: string): Promise<boolean> {
    let url: URL;
    try { url = new URL(candidate) } catch { return true }

    if (url.protocol === 'app:' || url.protocol === 'file:') return true;
    if (url.protocol === 'sulla-files-preview:') return !this.isAllowedCapabilityOrigin(url);
    if (url.protocol === 'data:' || url.protocol === 'blob:') return false;
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return true;
    return this.isPrivateNetworkHost(url.hostname);
  }

  private async routeExternalLink(candidate: string): Promise<void> {
    let url: URL;
    try { url = new URL(candidate) } catch { return }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !this.reserveLinkOpen()) return;
    if (await this.isPrivateNetworkHost(url.hostname)) return;
    this.openUrlInApp(url.toString());
  }

  private reserveLinkOpen(): boolean {
    const now = this.now();
    while (this.recentLinkOpens.length && this.recentLinkOpens[0] <= now - LINK_WINDOW_MS) this.recentLinkOpens.shift();
    if (this.recentLinkOpens.length >= LINK_LIMIT_PER_WINDOW) return false;
    this.recentLinkOpens.push(now);
    return true;
  }

  private async isPrivateNetworkHost(hostname: string): Promise<boolean> {
    const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home.arpa')) return true;

    const ipVersion = isIP(host);
    if (ipVersion) return this.isBlockedAddress(host, ipVersion === 4 ? 'ipv4' : 'ipv6');

    try {
      const result = await this.session.resolveHost(host, { source: 'system', cacheUsage: 'allowed' });
      if (!result.endpoints.length) return true;
      return result.endpoints.some(endpoint => {
        const version = isIP(endpoint.address);
        return !version || this.isBlockedAddress(endpoint.address, version === 4 ? 'ipv4' : 'ipv6');
      });
    } catch {
      return true;
    }
  }

  private isBlockedAddress(address: string, version: 'ipv4' | 'ipv6'): boolean {
    try {
      if (version === 'ipv6') {
        const mapped = this.mappedIpv4Address(address);
        if (mapped) return this.blockedNetworks.check(mapped, 'ipv4');
      }
      return this.blockedNetworks.check(address, version);
    } catch { return true }
  }

  private mappedIpv4Address(address: string): string | undefined {
    const normalized = new URL(`http://[${ address.replace(/^\[|\]$/g, '') }]/`).hostname.slice(1, -1).toLowerCase();
    if (!normalized.startsWith('::ffff:')) return undefined;
    const tail = normalized.slice('::ffff:'.length);
    if (isIP(tail) === 4) return tail;
    const groups = tail.split(':');
    if (groups.length !== 2 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return undefined;
    const high = Number.parseInt(groups[0], 16);
    const low = Number.parseInt(groups[1], 16);
    return `${ high >>> 8 }.${ high & 255 }.${ low >>> 8 }.${ low & 255 }`;
  }
}
