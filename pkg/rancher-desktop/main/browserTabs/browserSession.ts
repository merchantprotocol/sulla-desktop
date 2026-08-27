import { session, type Session } from 'electron';

/**
 * The one persistent Chromium session used by embedded browser tabs and every
 * browser-state API. Passing this Session object into WebContentsView avoids a
 * second partition lookup and makes the cookie-store identity explicit.
 */
export const BROWSER_SESSION_PARTITION = 'persist:sulla-browser';

export function getBrowserSession(): Session {
  return session.fromPartition(BROWSER_SESSION_PARTITION);
}
