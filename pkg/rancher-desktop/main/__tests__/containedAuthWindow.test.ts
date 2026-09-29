import { describe, expect, it, jest } from '@jest/globals';

import { plainChromeUserAgent } from '../containedAuthWindow';

jest.mock('electron', () => ({ BrowserWindow: jest.fn(), session: { fromPartition: jest.fn() } }));

describe('plainChromeUserAgent', () => {
  it('strips the app name and Electron token so sign-in pages see plain Chrome', () => {
    const electronUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Sulla Desktop/1.4.1 Chrome/142.0.7444.52 Electron/40.0.0 Safari/537.36';

    expect(plainChromeUserAgent(electronUa)).toBe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.52 Safari/537.36');
  });

  it('leaves a plain Chrome user agent unchanged', () => {
    const chromeUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.52 Safari/537.36';

    expect(plainChromeUserAgent(chromeUa)).toBe(chromeUa);
  });
});
