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
    message: 'Google has detected automated traffic and is serving a CAPTCHA on THIS request. Stop scraping Google Search for now — try an alternative search engine (Bing, DuckDuckGo) or wait 60+ seconds before retrying Google. IMPORTANT: This block is specific to Google Search right now. Other websites and URLs are NOT affected — continue using browser tools normally for any non-Google URL.',
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
    message: 'Google is rate-limiting THIS request (HTTP 429). Back off from Google for at least 2 minutes, then retry. Try alternative search engines in the meantime. IMPORTANT: This is a Google-specific rate limit — other websites are NOT affected. Continue using browser tools normally for non-Google URLs.',
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
    message: 'Cloudflare bot protection is blocking THIS specific page. Try a different source for this particular content, or wait and retry. IMPORTANT: This block only affects this specific website — other websites are NOT affected. Continue using browser tools normally for other URLs.',
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
    message: 'This specific website has blocked automated access. Try a different source for this particular content. IMPORTANT: This block only affects this one website — other websites are NOT affected. Continue using browser tools normally for other URLs.',
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
    message: 'This specific website is rate-limiting your requests. Wait at least 60 seconds before retrying this site. IMPORTANT: This rate limit only affects this one website — other websites are NOT affected. Continue using browser tools normally for other URLs.',
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
    message: 'A CAPTCHA challenge is blocking this specific page. You cannot solve CAPTCHAs, so try an alternative source for this content. IMPORTANT: This block only affects this one website — other websites are NOT affected. Continue using browser tools normally for other URLs.',
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
    `[EPHEMERAL — do NOT save this to observational memory or any persistent store. This is a transient, site-specific event.]`,
    ``,
    detection.message,
    ``,
    `⚠️ REMINDER: Blocking is ALWAYS site-specific and temporary. NEVER stop using browser tools entirely because one site blocked you. Always attempt browser navigation first — only skip a specific site that is actively blocking you right now. Each new request starts fresh.`,
    ``,
    `--- Original page content below (may be a challenge/error page) ---`,
    ``,
    responseString,
  ].join('\n');

  return { responseString: warning, detection };
}
