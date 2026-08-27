import { describe, expect, it, jest } from '@jest/globals';

import { SullaWebRequestFixer } from '../SullaWebRequestFixer';

describe('SullaWebRequestFixer cookie handling', () => {
  it('leaves Chromium native Cookie headers authoritative after Set-Cookie and document.cookie writes', () => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const webRequest = {
      onHeadersReceived:   jest.fn((handler: (...args: any[]) => void) => { handlers.headersReceived = handler }),
      onBeforeSendHeaders: jest.fn((handler: (...args: any[]) => void) => { handlers.beforeSendHeaders = handler }),
      onSendHeaders:       jest.fn((handler: (...args: any[]) => void) => { handlers.sendHeaders = handler }),
      onCompleted:         jest.fn((handler: (...args: any[]) => void) => { handlers.completed = handler }),
      onErrorOccurred:     jest.fn((handler: (...args: any[]) => void) => { handlers.errorOccurred = handler }),
    };
    const fixer = new SullaWebRequestFixer(jest.fn());

    fixer.attachToSession({ webRequest } as any);

    const responseCallback = jest.fn();
    handlers.headersReceived({
      id:              1,
      url:             'http://localhost:3000/auth',
      method:          'GET',
      statusCode:      200,
      resourceType:    'mainFrame',
      responseHeaders: { 'Set-Cookie': ['response_cookie=server; Path=/'] },
    }, responseCallback);

    expect(responseCallback).toHaveBeenCalledWith({
      responseHeaders: expect.objectContaining({
        'set-cookie': ['response_cookie=server; Path=/'],
      }),
    });

    // Chromium composes this header from its Session cookie store after the
    // response cookie and a page-side document.cookie write. The fixer must
    // pass that exact header through instead of overlaying a shadow cache.
    const nativeCookieHeader = 'response_cookie=server; document_cookie=page';
    const requestCallback = jest.fn();
    handlers.beforeSendHeaders({
      id:             2,
      url:            'http://localhost:3000/dashboard',
      method:         'GET',
      resourceType:   'xhr',
      requestHeaders: { Cookie: nativeCookieHeader },
    }, requestCallback);

    expect(requestCallback).toHaveBeenCalledTimes(1);
    expect(requestCallback).toHaveBeenCalledWith({
      requestHeaders: expect.objectContaining({ Cookie: nativeCookieHeader }),
    });
  });
});
