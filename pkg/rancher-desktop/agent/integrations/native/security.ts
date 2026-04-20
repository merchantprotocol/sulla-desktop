import type { Integration } from '../types';

export const nativeSecurityIntegrations: Record<string, Integration> = {
  apple_signin: {
    id:                'apple_signin',
    sort:              0,
    paid:              false,
    beta:              false,
    comingSoon:        false,
    connected:         false,
    name:              'Sign in with Apple',
    description:       'Sign in to Sulla Cloud with your Apple ID — the same account used by the Sulla Mobile app. Opens a secure browser window to Apple, then stores your session locally in this vault.',
    category:          'Security',
    icon:              'apple.svg',
    version:           '1.0.0',
    lastUpdated:       '2026-04-19',
    developer:         'Sulla',
    authType:          'oauth',
    oauthProviderId:   'apple',
    sullaManagedOAuth: true,
    formGuide:         'No configuration required — click "Sign in with Apple" to start. Sulla manages the OAuth app registration on your behalf.',
  },
  website: {
    id:          'website',
    sort:        1,
    paid:        false,
    beta:        true,
    comingSoon:  false,
    name:        'Website',
    description: 'Save and autofill website login credentials. Each saved website becomes a separate account.',
    category:    'Security',
    connected:   false,
    version:     '1.0.0',
    lastUpdated: '2026-03-31',
    developer:   'Sulla',
    properties:  [
      {
        key:         'website_url',
        title:       'Website URL',
        hint:        'The login page URL for this website',
        type:        'url',
        required:    true,
        placeholder: 'https://example.com/login',
      },
      {
        key:         'username',
        title:       'Username / Email',
        hint:        'Your login username or email address',
        type:        'text',
        required:    true,
        placeholder: 'user@example.com',
      },
      {
        key:         'password',
        title:       'Password',
        hint:        'Your login password',
        type:        'password',
        required:    true,
        placeholder: '',
      },
      {
        key:         'notes',
        title:       'Notes',
        hint:        'Optional notes about this credential',
        type:        'text',
        required:    false,
        placeholder: 'e.g. 2FA enabled, recovery codes in safe',
      },
      {
        key:         'llm_access',
        title:       'AI Access Level',
        hint:        'Controls what the AI agent can do with this credential: none (default), metadata, autofill, or full',
        type:        'select',
        required:    false,
        placeholder: 'none',
        selectBoxId: 'vault_llm_access',
      },
    ],
  },
  'google-safe-browsing': {
    id:          'google-safe-browsing',
    sort:        2,
    paid:        false,
    beta:        false,
    comingSoon:  false,
    name:        'Google Safe Browsing',
    description: 'Supercharge Sulla Desktop\'s threat proxy with Google\'s industry-leading URL reputation database — the same one that protects 5 billion devices through Chrome, Android, and Gmail. Every URL Claude Code opens, every link your AI agents click, every package your shell fetches is checked against 1M+ flagged malware, phishing, and unwanted-software sites before the connection is even established. Without this, the proxy falls back to a small local blocklist of ~500 recent threats; with it, you get Google-grade protection that refreshes in real time. Free tier covers 10,000 lookups per day, which is more than enough for an active developer workstation.',
    category:    'Security',
    icon:        'google.svg',
    connected:   false,
    version:     '1.0.0',
    lastUpdated: '2026-04-19',
    developer:   'Google',
    formGuide:   'Create an API key in Google Cloud Console, enable the Safe Browsing API, and paste the key here. Takes about 3 minutes. The key is encrypted in your local vault — it never leaves this machine.',
    installationGuide: {
      title:       'Google Safe Browsing API Setup',
      description: 'Create a free Safe Browsing API key in Google Cloud Console (3 minutes).',
      steps:       [
        {
          title:   'Create or select a Google Cloud project',
          content: `1. Go to https://console.cloud.google.com/
2. Click the project dropdown at the top
3. Click "New Project" (or pick an existing one you use for dev tooling)
4. Name it something like "sulla-desktop-security" and click Create`,
        },
        {
          title:   'Enable the Safe Browsing API',
          content: `1. In the same project, go to APIs & Services → Library
2. Search for "Safe Browsing API"
3. Click the result and press Enable
4. Wait a few seconds for Google to provision the API on your project`,
        },
        {
          title:   'Create the API key',
          content: `1. Go to APIs & Services → Credentials
2. Click "Create credentials" → "API key"
3. Copy the key that appears (starts with "AIzaSy...")
4. Optional but recommended: click "Restrict key" → under API restrictions, select only "Safe Browsing API". This limits blast radius if the key ever leaks.
5. Paste the key into the field below`,
        },
      ],
      importantNotes: [
        'The API is free up to 10,000 URL lookups per day — plenty for normal developer use.',
        'The key is stored encrypted in your local Sulla Desktop vault and is only sent to Google when the proxy checks a URL.',
        'Sulla Desktop never stores, transmits, or logs the key anywhere else.',
        'If you exceed the free tier, the proxy automatically rate-limits and falls back to URLhaus + VirusTotal.',
      ],
    },
    features: [
      {
        title:       '1M+ malicious URL database',
        description: 'Every URL Claude Code, npm, pip, curl, or any VM process fetches is checked against Google\'s live malware + phishing list before connecting.',
      },
      {
        title:       'Real-time threat updates',
        description: 'Google refreshes their database continuously — unlike static blocklists, you get protection against threats discovered minutes ago.',
      },
      {
        title:       'Automatic escalation pipeline',
        description: 'Runs after the zero-cost local URLhaus check. If URLhaus doesn\'t know the URL, Safe Browsing gets the second look. Unknowns escalate to VirusTotal if you connect that too.',
      },
      {
        title:       'Generous free tier',
        description: '10,000 URL checks per day at no cost. The proxy caches verdicts for 6 hours per clean URL and 7 days per blocked one, so a single active day rarely hits the limit.',
      },
      {
        title:       'Zero telemetry',
        description: 'Only the URL being fetched is sent to Google (required for the lookup). No identifying info, no user data, and Sulla Desktop never aggregates or reports your browsing patterns.',
      },
    ],
    guideLinks: [
      {
        title:       'Safe Browsing API — Get Started',
        description: 'Google\'s official walkthrough for provisioning the v4 API key.',
        url:         'https://developers.google.com/safe-browsing/v4/get-started',
      },
      {
        title:       'Usage limits & pricing',
        description: 'Free tier details and what happens if you exceed 10k/day.',
        url:         'https://developers.google.com/safe-browsing/v4/usage-limits',
      },
    ],
    properties: [
      {
        key:         'api_key',
        title:       'Safe Browsing API Key',
        hint:        'From Google Cloud Console → APIs & Services → Credentials, with Safe Browsing API enabled on the project.',
        type:        'password',
        required:    true,
        placeholder: 'AIzaSy...',
      },
    ],
  },
  virustotal: {
    id:          'virustotal',
    sort:        3,
    paid:        false,
    beta:        false,
    comingSoon:  false,
    name:        'VirusTotal',
    description: 'Add a 70-engine antivirus consensus check to Sulla Desktop\'s threat proxy. When a URL is unknown to both URLhaus and Google Safe Browsing — which is exactly when sophisticated, targeted threats slip through — VirusTotal cross-references it against Kaspersky, ESET, Bitdefender, Sophos, Fortinet, and 65+ other engines in a single API call. This is the reputation layer that catches the "nobody has seen this URL yet, but 4 of 70 scanners flag it" scenarios. Particularly valuable for AI agents that might be tricked into fetching crafted URLs from scraped content, README files, or user-supplied links. Free tier gives 500 lookups per day; the proxy rate-limits automatically and only escalates to VirusTotal for URLs that previous layers couldn\'t classify.',
    category:    'Security',
    icon:        'virustotal.svg',
    connected:   false,
    version:     '1.0.0',
    lastUpdated: '2026-04-19',
    developer:   'VirusTotal (Google)',
    formGuide:   'Sign up for a free VirusTotal account, grab your Public API key from Account Settings, and paste it below. Takes about 2 minutes. The key is encrypted in your local vault.',
    installationGuide: {
      title:       'VirusTotal API Key Setup',
      description: 'Grab your free Public API key from VirusTotal (2 minutes).',
      steps:       [
        {
          title:   'Create a VirusTotal account',
          content: `1. Go to https://www.virustotal.com/
2. Click "Sign in" (top right), then "Create account"
3. Sign up with email or use Google/Microsoft SSO
4. Verify your email address if prompted`,
        },
        {
          title:   'Copy your Public API key',
          content: `1. Once signed in, click your avatar in the top-right corner
2. Select "API key" from the dropdown
3. Your 64-character Public API key is shown — copy it
4. Paste it into the field below`,
        },
      ],
      importantNotes: [
        'The free Public API tier is 4 requests/minute and 500 requests/day.',
        'The proxy automatically enforces these limits and falls back gracefully when exhausted.',
        'The key is stored encrypted in your local Sulla Desktop vault.',
        'URLs are submitted to VirusTotal only when URLhaus and Safe Browsing return inconclusive results — typically a small fraction of your traffic.',
        'Heads up: VirusTotal\'s free tier makes submitted URLs visible to other researchers. Don\'t enable this integration if that\'s a concern for your environment.',
      ],
    },
    features: [
      {
        title:       '70+ antivirus engine consensus',
        description: 'One lookup cross-references Kaspersky, ESET, Bitdefender, Sophos, Fortinet, Malwarebytes, and dozens more. Blocks a URL when 2+ engines flag it as malicious.',
      },
      {
        title:       'Catches zero-day URLs',
        description: 'Shines on URLs that local blocklists and Safe Browsing don\'t know yet — exactly the profile of crafted phishing or supply-chain-attack links targeting AI agents.',
      },
      {
        title:       'Third-tier smart escalation',
        description: 'Only runs when URLhaus says "unknown" AND Safe Browsing says "unknown/error" — so your 500/day budget is spent on genuinely uncertain URLs, not routine traffic.',
      },
      {
        title:       'Built-in rate limiting',
        description: 'The proxy caps at 3 requests/minute (safely under VT\'s 4/min limit), drops requests gracefully over budget, and caches all verdicts for 6 hours.',
      },
      {
        title:       'Suspicious-tier signal',
        description: 'Even when a URL isn\'t outright malicious, VirusTotal\'s "suspicious" verdicts get tagged on responses so downstream tools and logs know to be careful.',
      },
    ],
    guideLinks: [
      {
        title:       'VirusTotal — Get an API key',
        description: 'Official docs: sign up and retrieve your free Public API key.',
        url:         'https://docs.virustotal.com/docs/please-give-me-an-api-key',
      },
      {
        title:       'Public API v3 reference',
        description: 'Endpoints, rate limits, and response schemas.',
        url:         'https://docs.virustotal.com/reference/overview',
      },
    ],
    properties: [
      {
        key:         'api_key',
        title:       'VirusTotal API Key',
        hint:        'Your 64-character Public API key from VirusTotal → avatar → "API key".',
        type:        'password',
        required:    true,
        placeholder: '',
      },
    ],
  },
};
