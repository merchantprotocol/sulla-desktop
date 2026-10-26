// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

// Sulla Server: the console's sign-in adapter. It replaces Cloud's js/sulla-auth.js and exposes the
// same window.SullaAuth surface, so Cloud's shell/api.js and every screen run unchanged.
//
// Sign-in happens in Keycloak (the themed sign-in page). Accounts then sets an HttpOnly session
// cookie plus a readable CSRF cookie on this origin. Requests go same-origin to /api with that
// cookie and the CSRF value in X-Sulla-CSRF. No token is ever stored in the browser.
(function () {
  'use strict';

  const BASE = '/api';
  const CSRF_COOKIE = 'sulla-console-csrf';
  const LOGIN_PATH = '/accounts-api/v1/web/login';
  const TEAM_KEY = 'sulla_team_id';
  const SIGNED_OUT_KEY = 'sulla_server_signed_out';
  const REDIRECTS_KEY = 'sulla_server_signin_redirects';
  const ACTIVATION_KEY = 'sulla_server_activation_checked';

  // Same team-scoped prefixes as js/sulla-auth.js: these routes take ?team=<active org>.
  const TEAM_PREFIXES = [
    '/crm/', '/records/', '/opportunities/', '/opportunity-stages/',
    '/discussions/', '/employees/', '/routines/', '/functions/',
    '/integrations/', '/plugins/', '/skills/', '/models/', '/permissions/',
  ];

  function cookie(name) {
    for (const part of document.cookie.split(';')) {
      const i = part.indexOf('=');
      if (i > -1 && part.slice(0, i).trim() === name) {
        try {
          return decodeURIComponent(part.slice(i + 1).trim());
        } catch (_) {
          return null;
        }
      }
    }
    return null;
  }

  function storage(kind) {
    try {
      return kind === 'session' ? window.sessionStorage : window.localStorage;
    } catch (_) {
      return null;
    }
  }

  function isAuthenticated() {
    return !!cookie(CSRF_COOKIE);
  }

  function signInUrl() {
    const returnTo = location.pathname + location.search + location.hash;
    return `${LOGIN_PATH}?returnTo=${encodeURIComponent(returnTo)}`;
  }

  // Sends the browser to the Keycloak sign-in page. A broken session that bounces straight back
  // would loop forever, so after three trips in a minute it stops and lets the page show an error.
  function goToSignIn() {
    const session = storage('session');
    const now = Date.now();
    let trips = [];
    try {
      trips = JSON.parse(session?.getItem(REDIRECTS_KEY) || '[]').filter((t) => now - t < 60000);
    } catch (_) {
      trips = [];
    }
    if (trips.length >= 3) return false;
    session?.setItem(REDIRECTS_KEY, JSON.stringify([...trips, now]));
    session?.removeItem(SIGNED_OUT_KEY);
    location.assign(signInUrl());
    return true;
  }

  // Every sign-in method on the shell's sign-in card ends up in Keycloak. The promise never
  // resolves: the page is navigating away.
  function signIn() {
    goToSignIn();
    return new Promise(() => {});
  }

  function sessionExpired() {
    try {
      window.dispatchEvent(new CustomEvent('sulla:session-expired'));
    } catch (_) {
      // nothing else to tell
    }
    goToSignIn();
  }

  function teamScoped(path) {
    if (!TEAM_PREFIXES.some((p) => path.startsWith(p))) return path;
    const team = storage('local')?.getItem(TEAM_KEY);
    if (!team) return path;
    return `${path}${path.includes('?') ? '&' : '?'}team=${encodeURIComponent(team)}`;
  }

  async function request(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const csrf = cookie(CSRF_COOKIE);
    if (csrf) headers['X-Sulla-CSRF'] = csrf;
    const res = await fetch(`${BASE}${teamScoped(path)}`, {
      ...opts,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (res.status === 401) {
      sessionExpired();
      const err = new Error('Unauthorized');
      err.status = 401;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`Sulla Server ${res.status}`);
      err.status = res.status;
      try {
        err.body = await res.json();
      } catch (_) {
        err.body = null;
      }
      throw err;
    }
    storage('session')?.removeItem(REDIRECTS_KEY);
    if (res.status === 204) return null;
    const type = res.headers.get('content-type') || '';
    return type.includes('application/json') ? res.json() : res.text();
  }

  const send = (method, path, body) => request(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  async function logout() {
    let res = null;
    try {
      res = await send('POST', '/auth/logout');
    } finally {
      storage('local')?.removeItem(TEAM_KEY);
      storage('session')?.setItem(SIGNED_OUT_KEY, '1');
    }
    // Ending the Keycloak session too needs the identity provider's logout page.
    const logoutUrl = res?.logoutUrl || res?.data?.logoutUrl;
    if (typeof logoutUrl === 'string' && /^(https:\/\/|\/)/.test(logoutUrl)) location.assign(logoutUrl);
    return res;
  }

  // A server admin's first sign-in on a server with no license goes to activation. Once per
  // browser session, so "Skip for now" sticks until the next sign-in.
  async function getMe() {
    const me = await request('/auth/me');
    const session = storage('session');
    const profile = me?.contractor || me;
    if (profile?.isServerAdmin === true && !session?.getItem(ACTIVATION_KEY)) {
      session?.setItem(ACTIVATION_KEY, '1');
      try {
        const res = await request('/server/v1/license');
        const license = res?.data ?? res;
        const notActivated = license?.state === 'missing' || license?.reason === 'not_activated';
        if (license?.valid === false && notActivated) {
          location.replace('activate.html');
          return new Promise(() => {});
        }
      } catch (_) {
        // The license section shows its own error; never block the console on it.
      }
    }
    return me;
  }

  // Not offered on a server: no phone sign-in, no Apple, no push, no self sign-up.
  function unavailable(what) {
    return () => Promise.reject(Object.assign(new Error(`${what} isn't available on this server.`), { status: 404 }));
  }

  window.SullaAuth = {
    BASE,
    getAccessToken: () => null,
    setTokens: () => {},
    isAuthenticated,
    request,

    // Sign-in methods: all of them are Keycloak.
    emailLogin: signIn,
    emailCodeStart: signIn,
    emailCodeVerify: signIn,
    sendOtp: signIn,
    verifyOtp: signIn,
    appleSignIn: signIn,
    getAppleSignInConfig: () => Promise.resolve({ enabled: false }),

    // Session and organizations
    getMe,
    logout,
    listTeams: () => request('/teams'),
    createTeam: (name) => send('POST', '/teams', { name }),
    switchTeam: (teamId) => send('POST', '/auth/switch-team', { teamId }),
    updateProfile: (patch) => send('PUT', '/contractors/profile', patch),

    // Notifications are email-only on a server and hidden for the first release.
    getNotificationPreferences: () => request('/notifications/preferences'),
    updateNotificationPreferences: (patch) => send('PUT', '/notifications/preferences', patch),
    sendTestNotification: (body = {}) => send('POST', '/notifications/test', body),
    getVapidKey: unavailable('Push notifications'),
    subscribePush: unavailable('Push notifications'),
    unsubscribePush: unavailable('Push notifications'),
  };

  // First visit without a session: straight to the sign-in page. Right after signing out, stay
  // on the console's own sign-in card instead, so the browser doesn't sign straight back in.
  if (!isAuthenticated() && document.body?.dataset.route && !storage('session')?.getItem(SIGNED_OUT_KEY)) {
    goToSignIn();
  }
})();
