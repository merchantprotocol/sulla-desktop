/**
 * detect_blocking.ts
 *
 * Detects rate-limiting, CAPTCHAs, and bot-blocking pages by analyzing
 * page text and URL. Returns a structured warning when blocking is detected
 * so the agent can adjust its plan (back off, switch sources, etc.).
 */

export interface BlockingDetection {
  blocked:    boolean;
  type:       'rate_limit' | 'captcha' | 'bot_block' | 'access_denied' | null;
  source:     string | null;   // e.g. "Google", "Cloudflare"
  message:    string | null;   // human-readable warning for the agent
}

interface BlockingPattern {
  type:    BlockingDetection['type'];
  source:  string;
  /** At least one pattern must match the page text (case-insensitive). */
  textPatterns: RegExp[];
  /** Optional: URL patterns that strengthen the match. */
  urlPatterns?: RegExp[];
  message: string;
}

const BLOCKING_PATTERNS: BlockingPattern[] = [
  // ── Google ──
  {
    type:    'captcha',
    source:  'Google',
    textPatterns: [
      /unusual traffic from your computer/i,
      /our systems have detected unusual traffic/i,
      /solve.*challenge/i,
      /please show you.*re not a robot/i,
      /before you continue to google/i,
    ],
    urlPatterns: [
      /google\.com\/sorry/i,
      /consent\.google/i,
      /accounts\.google\.com.*continue.*search/i,
    ],
    message: 'Google has detected automated traffic and is serving a CAPTCHA challenge. You MUST stop scraping Google immediately. Wait at least 60 seconds before trying again, or switch to an alternative source (Bing, DuckDuckGo, or a dedicated SEO API).',
  },
  {
    type:    'rate_limit',
    source:  'Google',
    textPatterns: [
      /429.*too many requests/i,
      /rate.?limit/i,
    ],
    urlPatterns: [
      /google\.com/i,
    ],
    message: 'Google is rate-limiting requests (HTTP 429). Back off for at least 2 minutes before retrying. Consider using alternative search engines or spacing out requests.',
  },

  // ── Cloudflare ──
  {
    type:    'bot_block',
    source:  'Cloudflare',
    textPatterns: [
      /checking.*browser.*before/i,
      /ray id/i,
      /cloudflare/i,
      /enable javascript and cookies to continue/i,
      /attention required.*cloudflare/i,
    ],
    urlPatterns: [
      /challenges\.cloudflare\.com/i,
    ],
    message: 'Cloudflare bot protection is blocking this page. The site requires browser verification that cannot be completed automatically. Try a different source or wait and retry.',
  },

  // ── Generic bot/access blocks ──
  {
    type:    'access_denied',
    source:  'Website',
    textPatterns: [
      /access denied/i,
      /403 forbidden/i,
      /you have been blocked/i,
      /automated access.*not permitted/i,
      /bot.*detected/i,
    ],
    message: 'This website has blocked automated access. Switch to a different source for this information.',
  },

  // ── Generic rate limiting ──
  {
    type:    'rate_limit',
    source:  'Website',
    textPatterns: [
      /too many requests/i,
      /rate limit exceeded/i,
      /slow down/i,
      /try again later/i,
      /request limit/i,
    ],
    message: 'This website is rate-limiting your requests. Wait at least 60 seconds before retrying.',
  },

  // ── hCaptcha / reCAPTCHA ──
  {
    type:    'captcha',
    source:  'Website',
    textPatterns: [
      /hcaptcha/i,
      /recaptcha/i,
      /verify you are human/i,
      /complete the security check/i,
      /prove you.*re not a robot/i,
      /i.*m not a robot/i,
    ],
    message: 'A CAPTCHA challenge is blocking this page. The agent cannot solve CAPTCHAs. Switch to an alternative source or API.',
  },
];

/**
 * Analyzes page text and URL for signs of rate-limiting or bot blocking.
 *
 * @param pageText - The visible text content of the page
 * @param pageUrl  - The current URL of the page
 * @returns Detection result; `blocked === false` means the page looks normal.
 */
export function detectBlocking(pageText: string, pageUrl: string): BlockingDetection {
  const text = pageText || '';
  const url  = pageUrl  || '';

  for (const pattern of BLOCKING_PATTERNS) {
    const textMatch = pattern.textPatterns.some(rx => rx.test(text));
    if (!textMatch) continue;

    // If URL patterns are defined, require at least one URL match too
    if (pattern.urlPatterns && pattern.urlPatterns.length > 0) {
      const urlMatch = pattern.urlPatterns.some(rx => rx.test(url));
      if (!urlMatch) continue;
    }

    return {
      blocked: true,
      type:    pattern.type,
      source:  pattern.source,
      message: pattern.message,
    };
  }

  return { blocked: false, type: null, source: null, message: null };
}

/**
 * Wraps a tool response string with a blocking warning banner if blocking
 * is detected. Returns the original string unchanged if no blocking found.
 */
export function wrapWithBlockingWarning(
  responseString: string,
  pageText: string,
  pageUrl: string,
): { responseString: string; detection: BlockingDetection } {
  const detection = detectBlocking(pageText, pageUrl);

  if (!detection.blocked) {
    return { responseString, detection };
  }

  const warning = [
    `⚠️ **BLOCKING DETECTED: ${ detection.type?.toUpperCase().replace('_', ' ') }** (source: ${ detection.source })`,
    ``,
    detection.message,
    ``,
    `--- Original page content below (may be a challenge/error page) ---`,
    ``,
    responseString,
  ].join('\n');

  return { responseString: warning, detection };
}
