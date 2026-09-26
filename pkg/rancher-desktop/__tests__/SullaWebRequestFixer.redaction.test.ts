/**
 * @jest-environment node
 */
import { describe, expect, it, jest } from '@jest/globals';

import { redactWebRequestEvent, SullaWebRequestFixer } from '../SullaWebRequestFixer';

describe('SullaWebRequestFixer logging', () => {
  it('redacts tokens, header values and cookies from logged events', () => {
    const redacted = redactWebRequestEvent({
      direction: 'request_headers',
      url:       'wss://127.0.0.1:8787/api/records/live?token=eyJsecret',
      payload:   {
        requestId:         1,
        requestHeaders:    { Cookie: 'session=abc', Authorization: 'Bearer xyz' },
        cookiePreview:     'session=abc...',
        originalSetCookie: ['sid=secret; Path=/', 'theme=dark'],
      },
    });
    const text = JSON.stringify(redacted);

    expect(redacted.url).toBe('wss://127.0.0.1:8787/api/records/live?…');
    expect(redacted.payload.requestHeaders).toEqual(['Cookie', 'Authorization']);
    expect(redacted.payload.originalSetCookie).toEqual(['sid', 'theme']);
    expect(text).not.toContain('eyJsecret');
    expect(text).not.toContain('abc');
    expect(text).not.toContain('xyz');
    expect(text).not.toContain('secret');
  });

  it('writes nothing per request unless SULLA_DEBUG_WEBREQUEST=1', () => {
    const write = jest.fn();
    const fixer = new SullaWebRequestFixer(write);
    const listeners: Record<string, (...args: any[]) => void> = {};
    const session: any = {
      webRequest: new Proxy({}, { get: (_t, name: string) => (fn: any) => { listeners[name] = fn } }),
    };

    fixer.attachToSession(session);
    listeners.onBeforeSendHeaders({ url: 'https://example.com/?t=1', requestHeaders: { Cookie: 'a=b' }, method: 'GET', id: 1 }, () => {});
    listeners.onSendHeaders({ url: 'https://example.com/?t=1', requestHeaders: { Cookie: 'a=b' }, method: 'GET', id: 1 });
    listeners.onCompleted({ url: 'https://example.com/?t=1', method: 'GET', id: 1, statusCode: 200 });
    listeners.onHeadersReceived({ url: 'http://localhost:3000/', responseHeaders: { 'set-cookie': ['sid=x'] }, id: 2 }, () => {});

    expect(write).not.toHaveBeenCalled();
  });
});
