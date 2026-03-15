// src/utils/PlaywrightClient.ts
import {
  chromium,
  firefox,
  webkit,
  Browser,
  BrowserContext,
  Page,
  LaunchOptions,
  BrowserType,
  Locator,
  ElementHandle,
  Response,
  Request,
} from 'playwright';

type BrowserName = 'chromium' | 'firefox' | 'webkit';

interface PlaywrightClientOptions {
  browser?:           BrowserName;
  headless?:          boolean;
  slowMo?:            number;
  timeout?:           number;
  userAgent?:         string;
  viewport?:          { width: number; height: number };
  proxy?:             { server: string; username?: string; password?: string };
  extraHTTPHeaders?:  Record<string, string>;
  storageState?:      string | { cookies: { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: 'Strict' | 'Lax' | 'None'; }[]; origins: { origin: string; localStorage: { name: string; value: string; }[]; }[]; };
  bypassCSP?:         boolean;
  ignoreHTTPSErrors?: boolean;
}

export class PlaywrightClient {
  private browser!:    Browser;
  private context!:    BrowserContext;
  private page!:       Page;
  private browserType: BrowserType<Browser>;

  constructor(private options: PlaywrightClientOptions = {}) {
    const browserName = options.browser || 'chromium';
    this.browserType = { chromium, firefox, webkit }[browserName];
  }

  async launch(): Promise<void> {
    const launchOpts: LaunchOptions = {
      headless: this.options.headless ?? true,
      slowMo:   this.options.slowMo,
      timeout:  this.options.timeout ?? 30000,
      args:     [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu', // often needed in containers/electron
      ],
    };

    if (this.options.proxy) {
      launchOpts.proxy = this.options.proxy;
    }

    this.browser = await this.browserType.launch(launchOpts);

    this.context = await this.browser.newContext({
      viewport:          this.options.viewport ?? { width: 1280, height: 800 },
      userAgent:         this.options.userAgent,
      extraHTTPHeaders:  this.options.extraHTTPHeaders,
      bypassCSP:         this.options.bypassCSP ?? true,
      ignoreHTTPSErrors: this.options.ignoreHTTPSErrors ?? true,
      storageState:      this.options.storageState,
    });

    this.page = await this.context.newPage();
  }

  async goto(url: string, waitUntil: 'load' | 'domcontentloaded' | 'networkidle' = 'networkidle'): Promise<Response | null> {
    return this.page.goto(url, { waitUntil, timeout: 60000 });
  }

  async waitForSelector(selector: string, options = { state: 'visible' as const, timeout: 30000 }): Promise<Locator> {
    const locator = this.page.locator(selector);
    await locator.waitFor(options);
    return locator;
  }

  async click(selector: string, options = {}): Promise<void> {
    await this.page.click(selector, options);
  }

  async type(selector: string, text: string, options = {}): Promise<void> {
    await this.page.fill(selector, text, options);
  }

  async getText(selector: string): Promise<string> {
    return this.page.locator(selector).innerText();
  }

  async getAttribute(selector: string, attr: string): Promise<string | null> {
    return this.page.locator(selector).getAttribute(attr);
  }

  async evaluate<R>(fn: () => Promise<R>): Promise<R> {
    return this.page.evaluate(fn);
  }

  async screenshot(path?: string, fullPage = true): Promise<Buffer | string> {
    return this.page.screenshot({ path, fullPage });
  }

  async pdf(path: string, options = { format: 'A4' }): Promise<Buffer> {
    return this.page.pdf({ path, ...options });
  }

  async interceptRequests(pattern: RegExp | string, handler: (route: any) => void): Promise<void> {
    await this.page.route(pattern, handler);
  }

  async close(): Promise<void> {
    if (this.context) await this.context.close();
    if (this.browser) await this.browser.close();
  }

  // Convenience: one-shot full automation
  async runTask<T>(task: (page: Page) => Promise<T>): Promise<T> {
    try {
      await this.launch();
      return await task(this.page);
    } finally {
      await this.close();
    }
  }

  get currentPage(): Page {
    return this.page;
  }

  get currentContext(): BrowserContext {
    return this.context;
  }
}
