const CHATGPT_AUTH_CLAIM = 'https://api.openai.com/auth';
const ACCOUNT_ID = /^[A-Za-z0-9._:-]{1,200}$/;

function jwtPayload(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== 'string' || token.length > 64 * 1024) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
      ? decoded as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract non-secret ChatGPT routing metadata from an OAuth token already in
 * authority custody. This never validates or returns the bearer token; the
 * upstream still authenticates the token and account pairing.
 */
export function extractChatgptAccountId(...tokens: unknown[]): string | undefined {
  for (const token of tokens) {
    const payload = jwtPayload(token);
    const auth = payload?.[CHATGPT_AUTH_CLAIM];
    const accountId = auth && typeof auth === 'object' && !Array.isArray(auth)
      ? (auth as Record<string, unknown>).chatgpt_account_id
      : undefined;
    if (typeof accountId === 'string' && accountId.trim() === accountId && ACCOUNT_ID.test(accountId)) {
      return accountId;
    }
  }
  return undefined;
}
