import { EventEmitter } from 'events';

import type { Session } from 'electron';

// ---------------------------------------------------------------------------
// Typed webRequest event names emitted by SullaWebRequestFixer
// ---------------------------------------------------------------------------

export interface WebRequestEventMap {
  beforeRequest:     [details: any];
  beforeSendHeaders: [details: any];
  headersReceived:   [details: any];
  sendHeaders:       [details: any];
  completed:         [details: any];
  errorOccurred:     [details: any];
}

export interface SullaWebRequestLogEvent {
  direction:     string;
  url?:          string;
  method?:       string;
  statusCode?:   number | string;
  resourceType?: string;
  payload?:      any;
}

interface UrlInfo {
  hostname: string;
  port:     string;
  baseUrl:  string;
}

/** Returns true for localhost, 127.0.0.1, 0.0.0.0 — our local services */
function isLocalhost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';
}

export class SullaWebRequestFixer extends EventEmitter {
  private writeEvent: (event: SullaWebRequestLogEvent) => void;
  private static readonly LOGGING_ENABLED = true;
  private hasLoggedN8nHealthz = false;
  private static readonly CONNECTIVITY_PROBE_URL_PREFIX = 'https://www.gstatic.com/generate_204';

  constructor(writeSullaWebRequestEvent: (event: SullaWebRequestLogEvent) => void) {
    super();
    this.writeEvent = SullaWebRequestFixer.LOGGING_ENABLED ? writeSullaWebRequestEvent : () => {};
  }

  private getUrlInfo(url: string): UrlInfo {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname;
      const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
      const baseUrl = `${ parsed.protocol }//${ hostname }:${ port }`;
      return { hostname, port, baseUrl };
    } catch {
      return { hostname: 'unknown', port: '80', baseUrl: 'http://unknown:80' };
    }
  }

  attachToSession(session: Session): void {
    this.writeEvent({
      direction: 'lifecycle',
      url:       'SullaWebRequestFixer',
      payload:   { message: 'SullaWebRequestFixer attached' },
    });

    // ==================== onHeadersReceived ====================
    session.webRequest.onHeadersReceived((details, callback) => {
      this.emit('headersReceived', details);

      // Skip header rewriting for app:// and x-rd-extension:// protocol responses —
      // Electron.protocol.handle responses don't support header modification and
      // attempting it causes ERR_UNEXPECTED (breaks SVG/image loading).
      if (details.url.startsWith('app://') || details.url.startsWith('x-rd-extension://')) {
        callback({});

        return;
      }

      const headers = { ...(details.responseHeaders || {}) };
      const shouldLog = this.shouldLogRequest(details.url);
      const urlInfo = this.getUrlInfo(details.url);
      const isLocal = isLocalhost(urlInfo.hostname);

      // Only strip security headers and override CSP for local services
      // (N8N, Twenty CRM, etc.).  External sites (Facebook, LinkedIn, etc.)
      // pass through untouched so we look like a normal browser.
      if (isLocal) {
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

        headers['Content-Security-Policy'] = [
          "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;",
          "script-src * 'unsafe-inline' 'unsafe-eval' data: blob:;",
          "style-src * 'unsafe-inline' 'unsafe-eval' data: blob:;",
          'img-src * data: blob:;',
          'font-src * data:;',
          "frame-ancestors app://* * 'self';",
          'connect-src *;',
        ];
      }

      // Only intercept Set-Cookie for local services
      if (isLocal) {
        this.handleSetCookie(headers, details, urlInfo);
      }

      if (shouldLog) {
        this.writeEvent({
          direction:    'response_headers',
          url:          details.url,
          method:       details.method,
          statusCode:   details.statusCode,
          resourceType: details.resourceType,
          payload:      { requestId: details.id, responseHeaders: headers },
        });
      }
      callback({ responseHeaders: headers });
    });

    // ==================== onBeforeSendHeaders ====================
    // Electron's webRequest callback is a one-time native callback (gin_helper).
    // The async IIFE below has both a success and a .catch() path that call it,
    // and the success-path invocation can throw (e.g. session torn down, request
    // cancelled). When it throws, the rejection lands in .catch() which would
    // call the callback a second time — Electron then throws "One-time callback
    // was called more than once". Wrap once at entry to enforce Electron's
    // own contract.
    session.webRequest.onBeforeSendHeaders((details, originalCallback) => {
      let callbackInvoked = false;
      const callback: typeof originalCallback = (response) => {
        if (callbackInvoked) return;
        callbackInvoked = true;
        originalCallback(response);
      };
      this.emit('beforeSendHeaders', details);

      if (details.url.startsWith('app://') || details.url.startsWith('x-rd-extension://')) {
        callback({ requestHeaders: details.requestHeaders });

        return;
      }

      try {
        const url = details.url.toLowerCase();
        let parsedUrl: URL | undefined;
        const shouldLog = this.shouldLogRequest(details.url);

        try {
          parsedUrl = new URL(details.url);
        } catch {
          parsedUrl = undefined;
        }

        const hostIsLocal = parsedUrl ? isLocalhost(parsedUrl.hostname) : false;

        // Only set default Origin/Referer for local services
        if (hostIsLocal) {
          details.requestHeaders['Origin'] = details.requestHeaders['Origin'] || parsedUrl?.origin || '';
          details.requestHeaders['Referer'] = details.requestHeaders['Referer'] || details.url;
        }

        // ANTHROPIC FIX
        if (url.includes('api.anthropic.com')) {
          details.requestHeaders['anthropic-dangerous-direct-browser-access'] = 'true';
        }

        if (shouldLog) {
          this.writeEvent({
            direction:    'request_headers',
            url:          details.url,
            method:       details.method,
            resourceType: details.resourceType,
            payload:      { requestId: details.id, requestHeaders: details.requestHeaders },
          });
        }

        callback({ requestHeaders: details.requestHeaders });
      } catch {
        callback({ requestHeaders: details.requestHeaders });
      }
    });

    // ==================== onSendHeaders ====================
    session.webRequest.onSendHeaders((details) => {
      this.emit('sendHeaders', details);
      if (this.shouldLogRequest(details.url)) {
        const hasCookie = !!details.requestHeaders['Cookie'] || !!details.requestHeaders['cookie'];
        const cookiePreview = hasCookie
          ? (details.requestHeaders['Cookie'] || details.requestHeaders['cookie']).substring(0, 100) + '...'
          : 'NO COOKIE HEADER';

        this.writeEvent({
          direction:    'request_sent',
          url:          details.url,
          method:       details.method,
          resourceType: details.resourceType,
          payload:      { requestId: details.id, hasCookieHeader: hasCookie, cookiePreview },
        });
      }
    });

    // ==================== onCompleted ====================
    session.webRequest.onCompleted((details) => {
      this.emit('completed', details);
      if (this.shouldLogRequest(details.url)) {
        this.writeEvent({
          direction:    'request_complete',
          url:          details.url,
          method:       details.method,
          statusCode:   details.statusCode,
          resourceType: details.resourceType,
          payload:      {
            requestId:  details.id,
            fromCache:  details.fromCache,
            statusLine: details.statusLine,
          },
        });
      }
    });

    // ==================== onErrorOccurred ====================
    session.webRequest.onErrorOccurred((details) => {
      this.emit('errorOccurred', details);
      if (this.shouldLogRequest(details.url)) {
        this.writeEvent({
          direction:    'request_error',
          url:          details.url,
          method:       details.method,
          resourceType: details.resourceType,
          payload:      { requestId: details.id, error: details.error },
        });
      }
    });

    if (SullaWebRequestFixer.LOGGING_ENABLED) {
      console.log('✅ SullaWebRequestFixer fully attached');
    }
  }

  private isLocalhostHttp(urlInfo: UrlInfo): boolean {
    const isLocalhost = urlInfo.hostname === 'localhost' || urlInfo.hostname === '127.0.0.1' || urlInfo.hostname === '0.0.0.0';

    return isLocalhost && urlInfo.baseUrl.startsWith('http://');
  }

  private handleSetCookie(headers: any, details: any, urlInfo: UrlInfo) {
    const setCookieHeaderKey = Object.keys(headers).find((key) => key.toLowerCase() === 'set-cookie');
    if (!setCookieHeaderKey) return;

    const rawSetCookieHeader = headers[setCookieHeaderKey];
    const originalCookies = Array.isArray(rawSetCookieHeader)
      ? [...rawSetCookieHeader]
      : [String(rawSetCookieHeader)];

    this.writeEvent({
      direction:    'response_headers',
      url:          details.url,
      method:       details.method,
      statusCode:   details.statusCode,
      resourceType: details.resourceType,
      payload:      { requestId: details.id, session: 'defaultSession', cookieRewritePhase: 'before', originalSetCookie: originalCookies },
    });

    const isLocalHttp = this.isLocalhostHttp(urlInfo);

    const rewrittenCookies = originalCookies.map((cookie: string) => {
      let c = cookie.trim();
      if (isLocalHttp) {
        // Localhost HTTP: SameSite=Lax, remove Secure (can't use Secure over HTTP)
        c = c.replace(/SameSite=(None|Lax|Strict)/gi, 'SameSite=Lax');
        c = c.replace(/;\s*Secure/gi, '');
      } else {
        // External/HTTPS: SameSite=None + Secure (required for cross-site iframe embedding)
        c = c.replace(/SameSite=(Lax|Strict)/gi, 'SameSite=None');
        if (!/SameSite=/i.test(c)) c += '; SameSite=None';
        if (!/;\s*Secure/i.test(c)) c += '; Secure';
      }
      if (!/Path=/i.test(c)) c += '; Path=/';
      // Do NOT add HttpOnly — many apps (e.g. Twenty CRM) store auth tokens in
      // cookies that frontend JS must read via document.cookie.  Adding HttpOnly
      // would make those cookies invisible to JavaScript and break auth flows.
      // Do NOT add Partitioned — it opts the cookie into CHIPS partitioning,
      // which isolates it by top-level site and breaks iframe session continuity.
      return c;
    });

    headers[setCookieHeaderKey] = rewrittenCookies;
    headers['set-cookie'] = rewrittenCookies;

    this.writeEvent({
      direction:    'response_headers',
      url:          details.url,
      method:       details.method,
      statusCode:   details.statusCode,
      resourceType: details.resourceType,
      payload:      {
        requestId:          details.id,
        session:            'persist:sulla-browser',
        cookieRewritePhase: 'after',
        rewrittenSetCookie: rewrittenCookies,
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
}
