// Sulla Server · Passwords (vault origin): CloudApi for the shared shell.
//
// The vault page runs on its own origin and never loads js/sulla-auth.js,
// so no bearer token exists here. This adapter gives shell.js the same
// surface it gets on the dashboard, backed by the HttpOnly vault session:
//   - a one-time #handoff=<code> from the dashboard is traded for the
//     session cookie, then removed from the URL;
//   - no session → back to the dashboard, which mints a new handoff;
//   - the organization is the one the handoff was minted in; switching
//     happens on the dashboard, never here.
// Load before shell.js.
(function () {
  'use strict';

  const CSRF = { 'X-Sulla-Vault-Request': '1' };
  const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content || '';
  const configured = meta('sulla-dashboard-origin');
  // Always ends in /, so relative paths stay under the console.
  const DASHBOARD = (/^https?:\/\//.test(configured)
    ? configured
    : `${location.protocol}//${location.host.replace(/^vault\./, '')}/console`).replace(/\/?$/, '/');

  let profile = null;
  let org = null;
  const models = new Set();
  const orgListeners = new Set();

  function dashboardUrl(path) {
    return new URL(path, DASHBOARD).href;
  }

  function toDashboard(path = 'passwords.html') {
    location.replace(dashboardUrl(path));
    return new Promise(() => {}); // keep the shell's loading curtain up while the page navigates
  }

  async function req(method, path, body) {
    const res = await fetch(`/cloud-vault-sync${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { ...CSRF, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = null;
    try { payload = await res.json(); } catch (_) { payload = null; }
    if (!res.ok) {
      const error = new Error(payload?.error || `Sulla Server returned ${res.status}`);
      error.status = res.status;
      error.body = payload;
      throw error;
    }
    return payload;
  }

  async function loadProfile() {
    const code = new URLSearchParams(location.hash.replace(/^#/, '')).get('handoff');
    if (code) {
      history.replaceState(null, '', location.pathname + location.search);
      await req('POST', '/browser/session', { code }).catch(() => null);
    }
    let me;
    try {
      me = await req('GET', '/browser/session');
    } catch (error) {
      if (error.status === 401 || error.status === 403) return toDashboard();
      throw error;
    }
    org = me.org ? { id: me.org.id, name: me.org.name, role: me.org.role, initials: me.org.initials || null, color: null, active: true } : null; // no inline avatar colour: the vault CSP blocks style attributes
    profile = {
      name: me.user?.name || me.user?.businessName || '',
      email: me.user?.email || '',
      activeTeamId: org?.id || null,
      memberships: org ? [{ teamId: org.id, teamName: org.name, role: org.role }] : [],
      vaultSession: me.session,
    };
    return profile;
  }

  // Ending the vault session navigates away; pagehide then wipes the worker.
  // Session-expired listeners are never fired here: the shell's response is
  // its token sign-in form, which doesn't exist on this origin.
  async function signOut() {
    await req('DELETE', '/browser/session').catch(() => null);
    profile = null;
  }

  window.CloudApi = {
    isSignedIn: () => true, // decided by loadProfile against the HttpOnly session
    loadProfile,
    loadTeams: async () => [],
    ensureOrg: async () => ({ needsOrg: !org }),
    profile: () => profile,
    signOut: async () => { await signOut(); await toDashboard('index.html'); },
    onSessionExpired: () => () => {},
    signIn: {}, // never used: without a session this page returns to the dashboard
    orgs: () => (org ? [org] : []),
    activeOrg: () => org,
    pinnedTeam: () => org?.id || null,
    switchOrg: () => toDashboard('organizations.html'),
    createOrg: () => toDashboard('organizations.html'),
    onOrgChange: (fn) => { orgListeners.add(fn); return () => orgListeners.delete(fn); },
    registerModel: (load) => { models.add(load); return () => models.delete(load); },
    // The sidebar's device list here is the Desktop this vault syncs from.
    listDevices: async () => {
      const org = await req('GET', '/browser/devices').catch(() => null);
      if (Array.isArray(org?.devices)) return org.devices;
      const status = await req('GET', '/status');
      if (!status?.enabled || !status.sourceDeviceId) return [];
      const seen = status.sourceDeviceLastSeenAt ? Date.parse(`${String(status.sourceDeviceLastSeenAt).replace(' ', 'T')}Z`) : 0;
      return [{
        id: status.sourceDeviceId, name: status.sourceDeviceName || 'Sulla Desktop', deviceType: 'desktop', platform: 'desktop',
        online: seen > 0 && Date.now() - seen < 120000, lastSeenAt: status.sourceDeviceLastSeenAt || null,
      }];
    },
  };

  window.VaultOrigin = { dashboardUrl, toDashboard };
})();
