import { describe, expect, it, jest } from '@jest/globals';

const mockCookieRecords: Electron.Cookie[] = [];
const mockCookies = {
  get: jest.fn(async(filter: Electron.CookiesGetFilter) => mockCookieRecords.filter((cookie) => {
    if (filter.name && cookie.name !== filter.name) return false;
    if (filter.domain && cookie.domain !== filter.domain) return false;
    if (filter.url && !filter.url.includes((cookie.domain ?? '').replace(/^\./, ''))) return false;
    return true;
  })),
  set: jest.fn(async(details: Electron.CookiesSetDetails) => {
    const domain = details.domain || new URL(details.url).hostname;
    const existing = mockCookieRecords.findIndex(cookie => cookie.name === details.name && cookie.domain === domain);
    const cookie = {
      name:     details.name,
      value:    details.value,
      domain,
      hostOnly: !details.domain,
      path:     details.path || '/',
      secure:   details.secure ?? false,
      httpOnly: details.httpOnly ?? false,
      session:  details.expirationDate === undefined,
      sameSite: details.sameSite ?? 'lax',
    } as Electron.Cookie;

    if (existing >= 0) mockCookieRecords[existing] = cookie;
    else mockCookieRecords.push(cookie);
  }),
  remove: jest.fn(async(url: string, name: string) => {
    const domain = new URL(url).hostname;
    const index = mockCookieRecords.findIndex(cookie => cookie.name === name && cookie.domain === domain);
    if (index >= 0) mockCookieRecords.splice(index, 1);
  }),
};
const mockBrowserSession = { cookies: mockCookies };

jest.unstable_mockModule('electron', () => ({
  default:         {},
  WebContentsView: jest.fn(),
  session:         { fromPartition: jest.fn(() => mockBrowserSession) },
}));

jest.unstable_mockModule('@pkg/main/browserTabs/TabRegistry', () => ({
  tabRegistry: { list: jest.fn(() => []) },
}));

jest.unstable_mockModule('@pkg/utils/logging', () => ({
  default: {
    sulla: {
      log:   jest.fn(),
      warn:  jest.fn(),
      error: jest.fn(),
    },
  },
}));

jest.unstable_mockModule('@pkg/window/browserTabViewManager', () => ({
  BrowserTabViewManager: {},
}));

describe('ChromeApiService cookies', () => {
  it('uses the same Session store as response and document.cookie writes', async() => {
    const { ChromeApiService } = await import('../ChromeApiService');
    const manager = {
      getWebRequestFixer: jest.fn(() => ({ on: jest.fn() })),
    };
    const api = ChromeApiService.getInstance(manager as any);
    const url = 'http://localhost:3000/dashboard';

    // Chromium writes both a Set-Cookie response and document.cookie into the
    // WebContents Session supplied by BrowserTabViewManager.
    await mockBrowserSession.cookies.set({ url, name: 'response_cookie', value: 'server' });
    await mockBrowserSession.cookies.set({ url, name: 'document_cookie', value: 'page' });

    expect((await api.cookies.getAll({ url })).map(cookie => cookie.name).sort()).toEqual([
      'document_cookie',
      'response_cookie',
    ]);

    // manage_cookies delegates to this chrome.cookies API. Its write must land
    // back in the exact store used by the WebContents network stack.
    await api.cookies.set({ url, name: 'api_cookie', value: 'tool' });

    expect((await mockBrowserSession.cookies.get({ url })).map(cookie => cookie.name).sort()).toEqual([
      'api_cookie',
      'document_cookie',
      'response_cookie',
    ]);
  });
});
