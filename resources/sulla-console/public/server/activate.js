// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.

// Sulla Server first run: activate the server with its license key, then connect a model provider.
// Same card and controls as the Cloud sign-in screen. The key is the signed token from the Sulla
// account's Servers & licenses page. Its claims are read here only to show what it grants before
// submitting; the server verifies the signature (POST /api/server/v1/license).
//
// activate.html#replace is the same card with only the license step, opened from
// Server administration › License.
(function () {
  'use strict';

  const ic = (n) => window.CloudIcons.get(n);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const host = document.querySelector('meta[name="sulla-server-host"]')?.content || location.host;
  const MANAGE_URL = 'https://sulladesktop.com/cloud/organization-settings.html#st=servers';
  const STEPS = ['License', 'Model providers'];
  const PROVIDERS = [['anthropic', 'Anthropic'], ['openai', 'OpenAI']];
  const replacing = location.hash === '#replace';
  const state = { serverId: null, license: null };

  const api = (method, path, body) => window.SullaAuth.request(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // ── License key claims (display only) ─────────────────────────────────
  function decodePart(part) {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function readKey(text) {
    const parts = text.replace(/\s+/g, '').split('.');
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
    try {
      const header = decodePart(parts[0]);
      const claims = decodePart(parts[1]);
      if (header.typ !== 'SULLA-SERVER-LICENSE' || claims.typ !== 'server-license') return null;
      return claims;
    } catch (_) {
      return null;
    }
  }

  function edition(claims) {
    if (claims.edition) return String(claims.edition)[0].toUpperCase() + String(claims.edition).slice(1);
    return claims.seatLimit == null ? 'Business' : 'Community';
  }

  function claimsHtml(claims) {
    const expires = new Date(Number(claims.exp) * 1000);
    const rows = [
      ['Edition', edition(claims)],
      ['Seats', claims.seatLimit == null ? 'No limit' : `Up to ${claims.seatLimit} people`],
      ['Use Cases catalog', (claims.features || []).includes('use_cases') ? 'Included' : 'Not included'],
      ['Valid until', Number.isNaN(+expires) ? '—' : expires.toLocaleDateString(undefined, { dateStyle: 'medium' })],
      ['Server ID', claims.serverId],
    ];
    return rows.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
  }

  function keyProblem(claims) {
    if (!claims) return 'That doesn’t look like a Sulla Server license key. Paste the whole key.';
    if (Number(claims.exp) * 1000 <= Date.now()) {
      return 'This key has expired. Get a renewed key from your Sulla account.';
    }
    if (state.serverId && claims.serverId !== state.serverId) {
      return `This key was issued for another server (${claims.serverId}). This server is ${state.serverId}.`;
    }
    return '';
  }

  // ── Theme box (same as the sign-in card) ──────────────────────────────
  function themeBox() {
    const opts = window.CloudTheme.SCHEMES.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
    return '<div class="themebox" title="Theme: the same token sets Sulla Desktop ships">'
      + '<label class="sel"><span>Theme</span> <b data-theme-label></b>'
      + `<select data-theme-scheme aria-label="Theme">${opts}</select></label>`
      + '<div class="seg" role="group" aria-label="Mode">'
      + `<button type="button" data-mode="light"><span class="bi">${ic('sun')}</span>Light</button>`
      + `<button type="button" data-mode="dark"><span class="bi">${ic('moon')}</span>Dark</button></div></div>`;
  }

  function syncTheme() {
    const t = window.CloudTheme.get();
    document.querySelectorAll('[data-theme-scheme]').forEach((s) => {
      s.value = t.scheme;
      const label = s.parentElement.querySelector('[data-theme-label]');
      if (label) label.textContent = s.selectedOptions[0]?.text || '';
    });
    document.querySelectorAll('[data-mode]').forEach((b) => {
      b.classList.toggle('on', b.dataset.mode === t.mode);
      b.setAttribute('aria-pressed', String(b.dataset.mode === t.mode));
    });
  }

  // ── Rendering ─────────────────────────────────────────────────────────
  function steps(current) {
    if (replacing) return '';
    const pills = STEPS.map((s, i) => {
      const tone = i < current ? 'ok' : i === current ? 'acc' : 'idle';
      return `<span class="pill ${tone}">${i < current ? '✓ ' : ''}${s}</span>`;
    });
    return `<div class="activate-steps">${pills.join('')}</div>`;
  }

  const LINKS = '<nav class="signin-links" aria-label="Sulla links">'
    + '<a href="https://sulladesktop.com/support.html">Help</a>'
    + '<a href="https://sulladesktop.com/privacy.html">Privacy</a>'
    + '<a href="https://sulladesktop.com/terms.html">Terms</a></nav>';

  function page(step, body) {
    const subtitle = replacing ? 'license key' : 'first-time setup';
    document.title = `${replacing ? 'License key' : 'Activate'} · Sulla Server`;
    const brand = '<div class="brand"><div class="mark">S</div>'
      + `<div><b>Sulla Server</b><span>${esc(host)} · ${subtitle}</span></div></div>`;
    document.body.innerHTML = `<div class="signin"><div class="signin-card">${brand}${steps(step)}${body}`
      + `${LINKS}${themeBox()}</div></div>`;
    syncTheme();
  }

  function skipLink() {
    return replacing
      ? '<a class="activate-skip" href="server-admin.html#st=license">Cancel</a>'
      : '<a class="activate-skip" href="index.html" data-skip>Skip for now</a>';
  }

  function renderLicense() {
    const heading = replacing ? 'Replace the license key' : 'Activate this server';
    const how = '<ol class="activate-how"><li>Sign in to your Sulla account at sulladesktop.com</li>'
      + '<li>Open <b>Organization settings › Servers &amp; licenses</b> and choose <b>Register a server</b></li>'
      + '<li>Copy the key and paste it here</li></ol>';
    const field = '<label>License key<textarea class="field mono" name="key" rows="5" autocomplete="off"'
      + ' spellcheck="false" placeholder="Paste the whole key" required></textarea></label>';
    page(0, `<h1>${heading}</h1>`
      + '<p>Paste the license key from your Sulla account. Community keys are free for up to 25 people.</p>'
      + how
      + `<form data-form novalidate>${field}<div class="activate-claims" data-claims hidden></div>`
      + '<button class="btn pri" type="submit" disabled>Activate</button></form>'
      + '<div class="err" role="alert" data-err></div>'
      + '<div class="signin-divider"><span>or</span></div>'
      + `<a class="btn" href="${MANAGE_URL}" target="_blank" rel="noopener">Manage in Sulla Cloud</a>`
      + skipLink()
      + '<p class="signin-new">The key is checked on this server. After that, the server reports only its seat count, '
      + 'once a day.</p>');

    const form = document.querySelector('[data-form]');
    const err = document.querySelector('[data-err]');
    const preview = document.querySelector('[data-claims]');
    const submit = form.querySelector('[type=submit]');
    form.key.addEventListener('input', () => {
      const text = form.key.value.trim();
      const claims = readKey(text);
      const problem = text ? keyProblem(claims) : '';
      err.textContent = problem;
      preview.hidden = !claims;
      preview.innerHTML = claims ? claimsHtml(claims) : '';
      submit.disabled = !claims || !!problem;
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true;
      err.textContent = '';
      try {
        const key = form.key.value.replace(/\s+/g, '');
        const res = await api('POST', '/server/v1/license', { licenseKey: key });
        state.license = res?.data ?? res;
        if (state.license?.valid === false) {
          err.textContent = state.license.message || 'The key could not be activated.';
          submit.disabled = false;
          return;
        }
        if (replacing) location.replace('server-admin.html#st=license');
        else renderProviders();
      } catch (error) {
        const body = error?.body || {};
        err.textContent = body.message || body.error || error.message || 'The key could not be activated.';
        submit.disabled = false;
      }
    });
    form.key.focus();
  }

  function renderProviders() {
    const l = state.license || {};
    const seats = typeof l.seats === 'number' || l.seats === null ? l.seats : l.seats?.total ?? l.seatLimit;
    const edition = l.edition ? `${String(l.edition)[0].toUpperCase()}${String(l.edition).slice(1)}` : 'Community';
    const who = l.registeredTo ? `Licensed to ${esc(l.registeredTo)} · ` : '';
    const options = PROVIDERS.map(([id, name]) => `<option value="${id}">${name}</option>`).join('');
    const limit = seats == null ? 'no seat limit' : `up to ${esc(seats)} people`;
    page(1, '<h1>Server activated</h1>'
      + `<p>${who}${esc(edition)} · ${limit}. Next, connect a model provider so agents can run. `
      + 'The key is stored in this server’s vault.</p>'
      + '<form data-form novalidate>'
      + `<label>Provider<select class="field" name="provider">${options}</select></label>`
      + '<label>API key<input class="field mono" name="apiKey" type="password" autocomplete="off" spellcheck="false"'
      + ' placeholder="Paste the key" required></label>'
      + '<button class="btn pri" type="submit">Save and open Sulla Server</button></form>'
      + '<div class="err" role="alert" data-err></div>'
      + skipLink()
      + '<p class="signin-new">You can add more providers later in Server administration › Model providers.</p>');

    const form = document.querySelector('[data-form]');
    const err = document.querySelector('[data-err]');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = form.apiKey.value.trim();
      if (!key) {
        err.textContent = 'Paste the API key, or skip this for now.';
        return;
      }
      const submit = form.querySelector('[type=submit]');
      submit.disabled = true;
      try {
        await api('PUT', `/server/v1/providers/${encodeURIComponent(form.provider.value)}`, { apiKey: key });
        location.replace('index.html');
      } catch (error) {
        err.textContent = error?.body?.error || error.message || 'The key could not be saved.';
        submit.disabled = false;
      }
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  document.addEventListener('click', (e) => {
    const mode = e.target.closest('[data-mode]');
    if (mode) window.CloudTheme.set({ mode: mode.dataset.mode });
  });
  document.addEventListener('change', (e) => {
    if (e.target.matches('[data-theme-scheme]')) window.CloudTheme.set({ scheme: e.target.value });
  });
  window.CloudTheme.onChange(syncTheme);

  async function boot() {
    renderLicense();
    try {
      const res = await api('GET', '/server/v1/license');
      const license = res?.data ?? res;
      state.serverId = license?.serverId || null;
    } catch (_) {
      // The server checks the key's server ID itself; this only adds an earlier hint.
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
