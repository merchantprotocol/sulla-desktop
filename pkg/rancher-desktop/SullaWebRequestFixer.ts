import { Session } from 'electron';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';

export interface SullaWebRequestLogEvent {
  direction: string;
  url?: string;
  method?: string;
  statusCode?: number | string;
  resourceType?: string;
  payload?: any;
}

interface UrlInfo {
  hostname: string;
  port: string;
  baseUrl: string;
  isN8n: boolean;
}

export class SullaWebRequestFixer {
  private cookieHeaderCacheByDomain: Record<string, string> = {};
  private writeEvent: (event: SullaWebRequestLogEvent) => void;
  private static readonly LOGGING_ENABLED = false;
  private hasLoggedN8nHealthz = false;
  private static readonly CONNECTIVITY_PROBE_URL_PREFIX = 'https://www.gstatic.com/generate_204';
  private static readonly COOKIE_PROPERTY_PREFIX = 'webRequestCookieHeader:';

  constructor(writeSullaWebRequestEvent: (event: SullaWebRequestLogEvent) => void) {
    this.writeEvent = SullaWebRequestFixer.LOGGING_ENABLED ? writeSullaWebRequestEvent : () => {};
  }

  private getUrlInfo(url: string): UrlInfo {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname;
      const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
      const baseUrl = `${parsed.protocol}//${hostname}:${port}`;
      const isN8n = port === '30119' || url.includes(':30119');
      return { hostname, port, baseUrl, isN8n };
    } catch {
      return { hostname: '127.0.0.1', port: '30119', baseUrl: 'http://127.0.0.1:30119', isN8n: true };
    }
  }

  attachToSession(session: Session): void {
    this.writeEvent({
      direction: 'lifecycle',
      url: 'SullaWebRequestFixer',
      payload: { message: 'SullaWebRequestFixer attached' },
    });

    // ==================== onHeadersReceived ====================
    session.webRequest.onHeadersReceived((details, callback) => {
      // Skip header rewriting for app:// and x-rd-extension:// protocol responses —
      // Electron.protocol.handle responses don't support header modification and
      // attempting it causes ERR_UNEXPECTED (breaks SVG/image loading).
      if (details.url.startsWith('app://') || details.url.startsWith('x-rd-extension://')) {
        callback({});

        return;
      }

      let headers = { ...(details.responseHeaders || {}) };
      const shouldLog = this.shouldLogRequest(details.url);

      // Strip framing / security headers
      delete headers['x-frame-options'];
      delete headers['X-Frame-Options'];
      delete headers['content-security-policy'];
      delete headers['Content-Security-Policy'];
      delete headers['x-frame-options-report'];
      delete headers['X-Frame-Options-Report'];
      delete headers['frame-ancestors'];
      delete headers['cross-origin-opener-policy'];
      delete headers['Cross-Origin-Opener-Policy'];
      delete headers['cross-origin-resource-policy'];
      delete headers['Cross-Origin-Resource-Policy'];
      delete headers['cross-origin-embedder-policy'];
      delete headers['Cross-Origin-Embedder-Policy'];
      delete headers['origin-agent-cluster'];
      delete headers['Origin-Agent-Cluster'];

      // Override CSP
      headers['Content-Security-Policy'] = [
        "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;",
        "script-src * 'unsafe-inline' 'unsafe-eval' data: blob:;",
        "style-src * 'unsafe-inline' 'unsafe-eval' data: blob:;",
        "img-src * data: blob:;",
        "font-src * data:;",
        "frame-ancestors app://* * 'self';",
        "connect-src *;"
      ];

      const urlInfo = this.getUrlInfo(details.url);
      if (urlInfo.isN8n) {
        this.handleN8nSetCookie(headers, details, urlInfo);
      }

      if (shouldLog) {
        this.writeEvent({
          direction: 'response_headers',
          url: details.url,
          method: details.method,
          statusCode: details.statusCode,
          resourceType: details.resourceType,
          payload: { requestId: details.id, responseHeaders: headers },
        });
      }
      callback({ responseHeaders: headers });
    });

    // ==================== onBeforeSendHeaders ====================
    session.webRequest.onBeforeSendHeaders((details, callback) => {
      if (details.url.startsWith('app://') || details.url.startsWith('x-rd-extension://')) {
        callback({ requestHeaders: details.requestHeaders });

        return;
      }

      void (async() => {
        const url = details.url.toLowerCase();
        let parsedUrl: URL | undefined;
        const shouldLog = this.shouldLogRequest(details.url);

        try {
          parsedUrl = new URL(details.url);
        } catch {
          parsedUrl = undefined;
        }

        // Global safe headers
        details.requestHeaders['Origin'] = details.requestHeaders['Origin'] || parsedUrl?.origin || '';
        details.requestHeaders['Referer'] = details.requestHeaders['Referer'] || details.url;

        const isLocalN8nRequest = !!parsedUrl
          && (parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1')
          && (parsedUrl.port === '30119' || details.url.includes('/rest/push'));

        // N8N SPECIFIC FIX
        if (isLocalN8nRequest && parsedUrl) {
          // ALWAYS use http:// origin for n8n, even on ws:// requests
          const n8nOrigin = `http://${parsedUrl.hostname}:30119`;

          details.requestHeaders['Origin'] = n8nOrigin;
          details.requestHeaders['Referer'] = `${n8nOrigin}/`;

          const resourceType = String(details.resourceType || '').toLowerCase();
          const isFrameNavigation = resourceType === 'subframe' || resourceType === 'mainframe';
          
          if (isFrameNavigation) {
            details.requestHeaders['Sec-Fetch-Site'] = 'cross-site';
            details.requestHeaders['Sec-Fetch-Mode'] = 'navigate';
            details.requestHeaders['Sec-Fetch-Dest'] = resourceType === 'mainframe' ? 'document' : 'iframe';
          } else {
            details.requestHeaders['Sec-Fetch-Site'] = 'same-origin';
            details.requestHeaders['Sec-Fetch-Mode'] = 'cors';
            details.requestHeaders['Sec-Fetch-Dest'] = 'empty';
          }

          details.requestHeaders['Sec-CH-UA'] = details.requestHeaders['Sec-CH-UA'] || '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"';
          details.requestHeaders['Sec-CH-UA-Mobile'] = details.requestHeaders['Sec-CH-UA-Mobile'] || '?0';
          details.requestHeaders['Sec-CH-UA-Platform'] = details.requestHeaders['Sec-CH-UA-Platform'] || '"macOS"';

          delete details.requestHeaders['Upgrade-Insecure-Requests'];
          delete details.requestHeaders['Sec-Fetch-User'];
          delete details.requestHeaders['Sec-Fetch-Storage-Access'];
        }

        // ANTHROPIC FIX
        if (url.includes('api.anthropic.com')) {
          details.requestHeaders['anthropic-dangerous-direct-browser-access'] = 'true';
        }

        // COOKIE INJECTION FROM CACHE / SETTINGS
        const urlInfo = this.getUrlInfo(details.url);
        const domainKey = this.getCookieDomainKey(details.url);
        const cachedCookieHeader = await this.loadCookieHeaderForDomain(domainKey);
        if (urlInfo.isN8n && cachedCookieHeader && shouldLog) {
          details.requestHeaders['Cookie'] = cachedCookieHeader;

          this.writeEvent({
            direction: 'request_headers',
            url: details.url,
            method: details.method,
            resourceType: details.resourceType,
            payload: {
              requestId: details.id,
              session: 'defaultSession',
              manualCookieHeaderInjection: 'SUCCESS (from cache)',
              injectedCookieHeader: cachedCookieHeader.substring(0, 120) + '...',
              cookieCount: cachedCookieHeader.split(';').length,
              targetUrl: urlInfo.baseUrl,
              domainKey,
            },
          });
        }

        if (shouldLog) {
          this.writeEvent({
            direction: 'request_headers',
            url: details.url,
            method: details.method,
            resourceType: details.resourceType,
            payload: { requestId: details.id, requestHeaders: details.requestHeaders },
          });
        }

        callback({ requestHeaders: details.requestHeaders });
      })().catch(() => {
        callback({ requestHeaders: details.requestHeaders });
      });
    });

    // ==================== onSendHeaders ====================
    session.webRequest.onSendHeaders((details) => {
      if (details.url.includes(':30119') || details.url.includes('127.0.0.1:30119')) {
        const hasCookie = !!details.requestHeaders['Cookie'] || !!details.requestHeaders['cookie'];
        const cookiePreview = hasCookie
          ? (details.requestHeaders['Cookie'] || details.requestHeaders['cookie']).substring(0, 100) + '...'
          : 'NO COOKIE HEADER';

        this.writeEvent({
          direction: 'request_sent',
          url: details.url,
          method: details.method,
          resourceType: details.resourceType,
          payload: { requestId: details.id, hasCookieHeader: hasCookie, cookiePreview },
        });
      }
    });

    // ==================== onCompleted ====================
    session.webRequest.onCompleted((details) => {
      if (this.shouldLogRequest(details.url)) {
        this.writeEvent({
          direction: 'request_complete',
          url: details.url,
          method: details.method,
          statusCode: details.statusCode,
          resourceType: details.resourceType,
          payload: { 
            requestId: details.id, 
            fromCache: details.fromCache, 
            statusLine: details.statusLine
          },
        });
      }
    });

    // ==================== onErrorOccurred ====================
    session.webRequest.onErrorOccurred((details) => {
      if (this.shouldLogRequest(details.url)) {
        this.writeEvent({
          direction: 'request_error',
          url: details.url,
          method: details.method,
          resourceType: details.resourceType,
          payload: { requestId: details.id, error: details.error },
        });
      }
    });

    if (SullaWebRequestFixer.LOGGING_ENABLED) {
      console.log('✅ SullaWebRequestFixer fully attached');
    }
  }

  private handleN8nSetCookie(headers: any, details: any, urlInfo: UrlInfo) {
    const setCookieHeaderKey = Object.keys(headers).find((key) => key.toLowerCase() === 'set-cookie');
    if (!setCookieHeaderKey) return;

    const rawSetCookieHeader = headers[setCookieHeaderKey];
    const originalCookies = Array.isArray(rawSetCookieHeader)
      ? [...rawSetCookieHeader]
      : [String(rawSetCookieHeader)];

    this.writeEvent({
      direction: 'response_headers',
      url: details.url,
      method: details.method,
      statusCode: details.statusCode,
      resourceType: details.resourceType,
      payload: { requestId: details.id, session: 'defaultSession', cookieRewritePhase: 'before', originalSetCookie: originalCookies },
    });

    const rewrittenCookies = originalCookies.map((cookie: string) => {
      let c = cookie.trim();
      if (urlInfo.isN8n) {
        c = c.replace(/SameSite=(None|Lax|Strict)/gi, 'SameSite=Lax');
        c = c.replace(/;\s*Secure/gi, '');
      } else {
        c = c.replace(/SameSite=(Lax|Strict)/gi, 'SameSite=None');
      }
      if (!/Path=/i.test(c)) c += '; Path=/';
      if (!/HttpOnly/i.test(c)) c += '; HttpOnly';
      if (!/Partitioned/i.test(c)) c += '; Partitioned';
      return c;
    });

    headers[setCookieHeaderKey] = rewrittenCookies;
    headers['set-cookie'] = rewrittenCookies;

    const cookieHeader = rewrittenCookies.join('; ');
    const domainKey = this.getCookieDomainKey(details.url);

    this.cookieHeaderCacheByDomain[domainKey] = cookieHeader;
    this.persistCookieHeaderForDomain(domainKey, cookieHeader);

    this.writeEvent({
      direction: 'response_headers',
      url: details.url,
      method: details.method,
      statusCode: details.statusCode,
      resourceType: details.resourceType,
      payload: {
        requestId: details.id,
        session: 'defaultSession',
        cookieRewritePhase: 'after',
        rewrittenSetCookie: rewrittenCookies,
        domainKey,
      },
    });
  }

  /**
   * 
   */
  private shouldLogRequest(url: string): boolean {
    if (url.startsWith(SullaWebRequestFixer.CONNECTIVITY_PROBE_URL_PREFIX)) {
      return false;
    }

    const isN8nHealthz = /^https?:\/\/(127\.0\.0\.1|localhost):30119\/healthz(?:[/?#]|$)/i.test(url);
    if (isN8nHealthz) {
      if (this.hasLoggedN8nHealthz) {
        return false;
      }
      this.hasLoggedN8nHealthz = true;
    }

    return true;
  }

  private getCookieDomainKey(url: string): string {
    const urlInfo = this.getUrlInfo(url);

    return `${urlInfo.hostname}:${urlInfo.port}`;
  }

  private getCookiePropertyName(domainKey: string): string {
    return `${SullaWebRequestFixer.COOKIE_PROPERTY_PREFIX}${domainKey}`;
  }

  private async loadCookieHeaderForDomain(domainKey: string): Promise<string> {
    const cachedCookieHeader = this.cookieHeaderCacheByDomain[domainKey] || '';

    if (cachedCookieHeader) {
      return cachedCookieHeader;
    }

    const persistedCookieHeader = await SullaSettingsModel.get(this.getCookiePropertyName(domainKey), '');
    const cookieHeader = typeof persistedCookieHeader === 'string' ? persistedCookieHeader : '';

    if (cookieHeader) {
      this.cookieHeaderCacheByDomain[domainKey] = cookieHeader;
    }

    return cookieHeader;
  }

  private persistCookieHeaderForDomain(domainKey: string, cookieHeader: string): void {
    void SullaSettingsModel
      .set(this.getCookiePropertyName(domainKey), cookieHeader, 'string')
      .catch(() => {});
  }

}