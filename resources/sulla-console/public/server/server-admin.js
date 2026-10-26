// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

// Sulla Server: Server administration. A settings screen in the same settings-nav layout as Account
// and Organization settings, built from Cloud's settings components (st-card, st-row, summary-grid,
// tbl, meters). Each section reads its own /server/v1/* route, so one failing service only breaks
// its own section. Controls with no backend in this release are disabled and say why.
(function () {
  'use strict';

  const shell = window.CloudShell;
  const states = window.CloudStates;
  const esc = (v) => shell.esc(v == null ? '' : String(v));
  const ic = (name) => window.CloudIcons.get(name);

  const SECTIONS = {
    overview: { label: 'Overview', path: '/server/v1/overview', wide: true },
    users: { label: 'Users & seats', path: '/server/v1/users', wide: true },
    license: { label: 'License', path: '/server/v1/license' },
    domains: { label: 'Domains & access', path: '/server/v1/domains' },
    signin: { label: 'Sign-in methods', path: '/server/v1/signin' },
    providers: { label: 'Model providers', path: '/server/v1/providers' },
    desktops: { label: 'Linked Desktops', path: '/server/v1/desktops', wide: true },
    storage: { label: 'Storage & backups', path: '/server/v1/storage' },
    updates: { label: 'Updates', path: '/server/v1/updates' },
    audit: { label: 'Audit log', path: '/server/v1/audit', wide: true },
  };
  const MANAGE_URL = 'https://sulladesktop.com/cloud/organization-settings.html#st=servers';
  const INSTALLER = 'Rerun the installer on the server: sudo bash /opt/sulla/server/install.sh';

  const state = { ctx: null, section: 'overview', data: {}, auditKind: 'all', userQuery: '' };

  // ── Small builders (same markup as the approved mockup) ───────────────
  const num = (v) => new Intl.NumberFormat().format(Number(v) || 0);
  const when = (v) => shell.localWhen(v);
  const pct = (part, whole) => (whole ? (Number(part) / Number(whole)) * 100 : 0);

  function fmtDate(v) {
    const d = new Date(v);
    if (Number.isNaN(+d)) return String(v || '');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function initials(name) {
    return String(name || '?')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((x) => x[0])
      .join('')
      .toUpperCase();
  }

  function since(v) {
    const ms = Date.now() - new Date(v).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '';
    const days = Math.floor(ms / 86400000);
    if (days >= 1) return `${days}d`;
    const hours = Math.floor(ms / 3600000);
    return hours >= 1 ? `${hours}h` : `${Math.max(1, Math.floor(ms / 60000))}m`;
  }

  const pill = (label, tone = 'idle') => `<span class="pill ${tone}">${esc(label)}</span>`;

  function btn(label, attrs = '', cls = '') {
    return `<button type="button" class="btn sm ${cls}" ${attrs}>${label}</button>`;
  }

  // A control this release can't act on yet: disabled, with the reason as its tooltip.
  const later = (reason) => `disabled title="${esc(reason)}"`;

  function card(title, body, sub = '', actions = '', cls = '') {
    const heading = `<h2 class="${cls === 'danger' ? 'danger-h' : ''}">${title}</h2>${sub ? `<p>${sub}</p>` : ''}`;
    return `<section class="st-card ${cls}"><div class="card-h"><div>${heading}</div>`
      + `<div class="r">${actions}</div></div>${body}</section>`;
  }

  function row(title, copy, right = '') {
    const left = `<b>${title}</b>${copy ? `<small>${copy}</small>` : ''}`;
    return `<div class="st-row"><div class="l">${left}</div><div class="r">${right}</div></div>`;
  }

  function toggle(on, label, attrs = '') {
    const input = `<input type="checkbox" ${on ? 'checked' : ''} aria-label="${esc(label)}" ${attrs}>`;
    return `<label class="switch" title="${esc(label)}">${input}<i></i></label>`;
  }

  function meter(name, value, of, percent, left, right) {
    const width = Math.max(0, Math.min(100, percent || 0));
    return `<article class="st-card meter"><b>${name}</b><span class="value">${value} <small>${of}</small></span>`
      + `<div class="bar"><i style="width:${width}%"></i></div>`
      + `<div class="meter-meta"><span>${left}</span><span>${right}</span></div></article>`;
  }

  function summary(label, value, desc, mark = '', suffix = '') {
    const dot = mark ? `<i class="status-dot ${mark}" aria-hidden="true"></i>` : '';
    return `<article class="summary-card"><div class="summary-label">${dot}${esc(label)}</div>`
      + `<strong>${esc(value)}${suffix ? `<small>${esc(suffix)}</small>` : ''}</strong>`
      + `<span>${esc(desc)}</span></article>`;
  }

  function table(cols, rows, numeric = []) {
    const cell = (tag, c, i) => `<${tag}${numeric.includes(i) ? ' class="num"' : ''}>${c}</${tag}>`;
    const head = cols.map((c, i) => cell('th', esc(c), i)).join('');
    const body = rows.map((r) => `<tr>${r.map((c, i) => cell('td', c, i)).join('')}</tr>`).join('');
    return `<div class="table-wrap"><table class="tbl"><thead><tr>${head}</tr></thead>`
      + `<tbody>${body}</tbody></table></div>`;
  }

  function emptyRow(title, copy) {
    return `<div class="empty-settings"><b>${esc(title)}</b><span>${esc(copy)}</span></div>`;
  }

  // Seats arrive as { used, total } (overview, users) or as the license's seat limit number.
  function seatsOf(d) {
    const seats = d?.seats;
    if (typeof seats === 'number' || seats === null) return { used: d?.seatsUsed ?? null, total: seats };
    return {
      used: Number(seats?.used ?? d?.seatsUsed ?? 0),
      total: seats?.total ?? seats?.limit ?? d?.seatLimit ?? null,
    };
  }

  const cap = (s) => (s ? `${String(s)[0].toUpperCase()}${String(s).slice(1)}` : '');

  // ── Sections ──────────────────────────────────────────────────────────
  function serviceHealthy(s) {
    return s.state === 'running' && (!s.health || s.health === 'healthy');
  }

  function overviewHtml(d) {
    const services = d.services || [];
    const bad = services.filter((s) => !serviceHealthy(s));
    const healthy = services.length > 0 && bad.length === 0;
    const seats = seatsOf(d);
    const m = d.machine || {};
    const free = seats.total == null
      ? 'No seat limit'
      : `${seats.total - seats.used} free on the ${d.edition} license`;
    const statusDesc = healthy
      ? `All ${services.length} services running`
      : `${bad.length} of ${services.length} need attention`;
    const tiles = summary('Status', healthy ? 'Healthy' : 'Needs attention', statusDesc,
      healthy ? 'running' : 'problem')
      + summary('Seats', seats.used, free, '', seats.total == null ? '' : ` / ${seats.total}`)
      + summary('Storage', `${d.storage?.usedGb ?? 0} GB`, `of ${d.storage?.totalGb ?? 0} GB`)
      + summary('Version', d.version || '—', d.updateAvailable ? 'Update available' : 'Up to date');
    const rows = services.map((s) => {
      const dot = serviceHealthy(s) ? 'running' : 'problem';
      const status = serviceHealthy(s)
        ? `Up ${esc(s.up || since(s.startedAt))}`
        : esc(s.status || s.state || 'Stopped');
      const name = `<b><i class="status-dot ${dot}" aria-hidden="true"></i> ${esc(s.name)}</b>`;
      const logs = `data-logs="${esc(s.id || s.container)}" data-logs-name="${esc(s.name)}"`;
      const actions = btn('Logs', logs, 'ghost')
        + btn('Restart', later(`Restart from the server: docker compose restart ${s.container}`));
      return `<div class="st-row"><div class="l">${name}<small class="mono">${esc(s.container)}</small></div>`
        + `<div class="r"><span class="muted">${status}</span>${actions}</div></div>`;
    }).join('');
    const memPct = pct(m.memUsedGb, m.memoryGb);
    const diskPct = pct(m.diskUsedGb, m.diskTotalGb);
    const meters = meter('CPU', `${m.cpuPct ?? 0}%`, 'average', m.cpuPct, 'Last hour', esc(m.chip || ''))
      + meter('Memory', `${m.memUsedGb ?? 0} GB`, `of ${m.memoryGb ?? 0} GB`, memPct, `${Math.round(memPct)}% used`,
        esc(m.name || ''))
      + meter('Disk', `${m.diskUsedGb ?? 0} GB`, `of ${m.diskTotalGb ?? 0} GB`, diskPct, `${Math.round(diskPct)}% used`,
        'Data folder');
    return `<section class="summary-grid">${tiles}</section>`
      + card('Services', rows || emptyRow('No services reported', 'The container list is unavailable.'),
        'Every container that makes up this server.',
        btn('Restart all', later('Restart from the server with docker compose')))
      + `<div class="meters">${meters}</div>`;
  }

  function userRow(u) {
    const invited = u.status === 'invited' || u.role === 'invited';
    const disabled = u.status === 'disabled';
    const base = String(u.role || 'member');
    let role = invited ? 'Invited' : `${base[0].toUpperCase()}${base.slice(1)}`;
    if (u.isServerAdmin) role = 'Server admin';
    if (disabled) role = 'Suspended';
    const tone = role === 'Server admin' ? 'acc' : role === 'Invited' || role === 'Suspended' ? 'warn' : 'idle';
    const you = u.isYou ? ' <span class="tag you">You</span>' : '';
    let action = '';
    if (!u.isYou && invited && u.invitationId && u.orgId) {
      action = btn('Resend', `data-resend="${esc(u.invitationId)}" data-org="${esc(u.orgId)}"`, 'ghost');
    } else if (!u.isYou && disabled) {
      action = btn('Restore', `data-user-enable="${esc(u.id)}"`, 'ghost');
    } else if (!u.isYou && !invited) {
      action = btn('Suspend', `data-user-disable="${esc(u.id)}" data-user-name="${esc(u.name)}"`, 'ghost');
    }
    const who = `<span class="avatar">${esc(initials(u.name))}</span>`
      + `<span class="t"><b>${esc(u.name)}${you}</b><small>${esc(u.email)} · ${esc(u.org)}</small></span>`;
    return `<div class="st-row"><div class="who">${who}</div><div class="role">${pill(role, tone)}</div>`
      + `<div class="joined">${u.joinedAt ? `Joined ${esc(fmtDate(u.joinedAt))}` : 'Pending'}</div>`
      + `<div class="acts">${action}</div></div>`;
  }

  function usersHtml(d) {
    const q = state.userQuery.toLowerCase();
    const users = (d.users || []).filter((u) => !q || `${u.name} ${u.email} ${u.org}`.toLowerCase().includes(q));
    const seats = seatsOf(d);
    const people = users.map(userRow).join('');
    const search = '<input class="field" type="search" data-user-search placeholder="Search users"'
      + ` value="${esc(state.userQuery)}" style="width:200px">`;
    const invite = '<a class="btn sm pri" href="organization-settings.html#st=members">Invite user</a>';
    const seatMeter = seats.total == null
      ? meter('Seats', seats.used, 'used', 0, 'No seat limit', `${esc(d.edition)} license`)
      : meter('Seats', seats.used, `of ${seats.total}`, pct(seats.used, seats.total),
        `${seats.total - seats.used} free`, `${esc(d.edition)} license`);
    const upsell = seats.total == null ? '' : card(`Need more than ${seats.total} people?`, row(
      'Sulla Server Business',
      'Removes the seat limit. Buy a key from your Sulla account and paste it under License.',
      '<a class="btn sm pri" href="server-admin.html#st=license">See license</a>',
    ));
    return `<div class="meters">${seatMeter}</div>${upsell}`
      + card('Users', people || emptyRow('No matching users', 'Try another search.'),
        'Everyone with an account on this server, across all organizations. New accounts are invite only.',
        `${search}${invite}`);
  }

  function licenseHtml(d) {
    const valid = d.valid === true;
    const seats = seatsOf(d);
    const notice = valid ? '' : '<div class="banner info"><b>This server’s license key isn’t valid.</b>'
      + '<span>Use Cases can’t browse, install or update until a valid key is entered. '
      + 'Everything else keeps working.</span></div>';
    const notActivated = d.state === 'missing' || d.reason === 'not_activated';
    const edition = cap(d.edition);
    const keyState = notActivated
      ? pill('Not activated', 'warn')
      : pill(valid ? 'Valid' : 'Not valid', valid ? 'ok' : 'bad');
    const catalog = valid && d.catalogAllowed !== false;
    const replace = `<a class="btn sm ${valid ? '' : 'pri'}" href="activate.html#replace">`
      + `${d.masked ? 'Replace key' : 'Enter key'}</a>`;
    const rows = row('Key', 'Checked on this server with Sulla’s public key. Works offline.',
      `<span class="mono">${esc(d.masked || '—')}</span>${keyState}`)
      + row('Registered to', esc(d.registeredTo || 'Not registered yet'),
        `<a class="btn sm" href="${MANAGE_URL}" target="_blank" rel="noopener">Manage in Sulla Cloud</a>`)
      + row('Server ID', 'Created when this server was installed.',
        `<span class="mono">${esc(d.serverId || '—')}</span>`)
      + row('Edition', `${esc(edition || '—')}${edition === 'Community' ? ' · free' : ''}`,
        pill(valid ? 'Active' : 'Inactive', valid ? 'ok' : 'warn'))
      + row('Seats', seatsCopy(seats), '')
      + row('Use Cases catalog', 'Browsing, installing and updating use cases needs an active license key.',
        pill(catalog ? 'Included' : 'Locked', catalog ? 'ok' : 'warn'))
      + row('Next check-in',
        'The seat count is reported to sulladesktop.com once a day. No other data leaves this server.',
        `<span class="muted">${esc(d.nextCheckIn ? when(d.nextCheckIn) : '—')}</span>`);
    const business = '<article class="plan"><h3>Business</h3>'
      + '<div class="price">Unlimited <small>seats</small></div><ul>'
      + '<li>Priority updates</li><li>Support from Merchant Protocol</li></ul>'
      + `<a class="btn pri" href="${MANAGE_URL}" target="_blank" rel="noopener">Manage in Sulla Cloud</a></article>`;
    const community = `<article class="plan ${edition === 'Community' ? 'current' : ''}">`
      + `${edition === 'Community' ? '<span class="pill acc">Current</span>' : ''}<h3>Community</h3>`
      + '<div class="price">Free</div><ul><li>Up to <b>25 people</b></li><li>Invite-only sign-up</li></ul>'
      + '<button class="btn" disabled>Current edition</button></article>';
    const enterprise = '<article class="plan"><h3>Enterprise</h3><div class="price">Custom</div>'
      + '<ul><li>Single sign-on</li>'
      + '<li>Audit log export</li></ul><button class="btn" disabled>Contact sales</button></article>';
    return notice
      + card('License key', rows, '', replace)
      + card('Editions', `<div class="st-plan-grid">${community}${business}${enterprise}</div>`,
        'Buy a key from your Sulla account, then paste it above.')
      + card('Terms', row('License', 'Sulla Fair-Code License 1.0. Run it for your own team or company. '
        + 'You can’t resell it, charge people to use it, or bypass the license key.',
      '<a class="btn sm ghost" href="https://sulladesktop.com/terms.html">Read</a>'));
  }

  function seatsCopy(seats) {
    if (seats.used == null) return seats.total == null ? 'No seat limit' : `Up to ${seats.total} people`;
    return seats.total == null ? `${seats.used} used · no limit` : `${seats.used} of ${seats.total} used`;
  }

  function certPill(cert) {
    if (!cert) return pill('No certificate', 'warn');
    const days = Math.floor((new Date(cert.expiresAt).getTime() - Date.now()) / 86400000);
    if (!Number.isFinite(days)) return pill('TLS', 'idle');
    if (days > 14) return pill(`TLS valid · ${days} days`, 'ok');
    return pill(`TLS expires in ${Math.max(days, 0)} days`, 'warn');
  }

  function domainsHtml(d) {
    const net = d.network || {};
    const relayDown = d.relayConnected === false;
    const ranges = esc((net.allowedRanges || []).join(', '));
    const addresses = row('Console', 'Everything in this app.',
      `<span class="mono">https://${esc(d.host)}</span>${certPill(d.certificate)}`)
      + row('Vault', 'Passwords open on their own address.',
        `<span class="mono">https://${esc(d.vaultHost)}</span>${certPill(d.vaultCertificate || d.certificate)}`)
      + row('Relay', 'Phones and remote Desktops connect here.',
        `<span class="mono">${esc(d.relayUrl || `wss://${d.host}/relay`)}</span>`
        + pill(relayDown ? 'Offline' : 'Connected', relayDown ? 'warn' : 'ok'));
    return card('Addresses', addresses, 'Where people and devices reach this server.', btn('Edit', later(INSTALLER)))
      + card('Certificates', row('Let’s Encrypt', 'Renews automatically 30 days before it expires.',
        toggle(d.letsEncrypt === true, 'Let’s Encrypt', later('Automatic certificates arrive in a later release')))
        + row('Use my own certificate', 'Upload a PEM certificate and key.', btn('Upload', later(INSTALLER))))
      + card('Network', row('Local network access', 'Desktops on the office network can find this server.',
        toggle(net.lan !== false, 'Local network access', later(INSTALLER)))
        + row('Public internet access', 'Reachable outside the office through the relay.',
          toggle(net.public === true, 'Public internet access', later(INSTALLER)))
        + row('Allowed IP ranges', 'Leave empty to allow any address.',
          `<input class="field" placeholder="10.0.0.0/8, 192.168.1.0/24" value="${ranges}" ${later(INSTALLER)}>`));
  }

  function signinHtml(d) {
    const methods = d.methods || {};
    const smtp = d.smtp || {};
    const days = [7, 14, 30].map((n) => {
      const selected = Number(d.invitationDays) === n ? 'selected' : '';
      return `<option value="${n}" ${selected}>${n} days</option>`;
    });
    const smtpCopy = smtp.host
      ? `${esc(smtp.host)}:${esc(smtp.port || 587)} · used for invitations and sign-in codes.`
      : 'Not set up yet. Invitations can’t be emailed until it is.';
    return card('Methods', row('Email and password', 'People can add two-step verification in Sign-in &amp; security.',
      toggle(methods.password !== false, 'Email and password', later('Email and password is always on')))
      + row('Email code', 'A one-time code by email.', toggle(methods.emailCode === true, 'Email code',
        later('Email-code sign-in arrives in a later release')))
      + row('Single sign-on', 'SAML and OpenID Connect. Part of Sulla Server Enterprise.', pill('Enterprise', 'idle')),
    'How people sign in to this server.')
      + card('Accounts', row('New accounts',
        'Invite only. Owners and admins invite people from Members &amp; invites '
        + 'or Users &amp; seats.', pill('Invite only', 'acc'))
        + row('Require two-step verification', 'For everyone on this server.',
          toggle(d.requireTwoStep === true, 'Require two-step verification', 'data-signin-twostep'))
        + row('Invitations expire after', '', `<select class="field" data-signin-days>${days.join('')}</select>`))
      + card('Email delivery', row('SMTP server', smtpCopy, btn('Edit', 'data-smtp-edit'))
        + row('Send a test email', `To ${esc(state.ctx.profile?.email || '')}.`,
          btn('Send test', `data-smtp-test ${smtp.host ? '' : 'disabled'}`)));
  }

  function providersHtml(d) {
    const rows = (d.providers || []).map((p) => {
      const on = p.connected === true;
      const who = `<span class="avatar sq">${esc(String(p.name || '?')[0])}</span>`
        + `<span class="t"><b>${esc(p.name)}</b>`
        + `<small>${esc(p.description || (on ? '' : 'Not connected'))}</small></span>`;
      const act = btn(on ? 'Edit' : 'Connect', `data-provider="${esc(p.id)}"`, on ? 'ghost' : '');
      return `<div class="st-row"><div class="who">${who}</div>`
        + `<div class="role">${pill(on ? 'Connected' : 'Off', on ? 'ok' : 'idle')}</div>`
        + `<div class="joined mono">${esc(p.keyHint || p.baseUrl || '')}</div><div class="acts">${act}</div></div>`;
    }).join('');
    const models = d.models || [];
    const option = (id, current) => {
      const m = models.find((x) => x.id === id);
      return `<option value="${esc(id)}" ${id === current ? 'selected' : ''}>${esc(m?.label || id)}</option>`;
    };
    const defaults = d.defaults || {};
    const modelOptions = models.map((m) => option(m.id, defaults.model)).join('');
    const fallbackOptions = models.map((m) => option(m.id, defaults.fallback)).join('');
    return '<div class="banner info"><b>Your own keys.</b><span>Every token is billed by the provider to your '
      + 'account. Keys are stored in the vault and never shown to agents.</span></div>'
      + card('Providers', rows || emptyRow('No providers yet', 'Connect one so agents can run.'), '',
        btn('+ Add provider', 'data-provider=""', 'pri'))
      + card('Defaults', row('Default model', 'Used when an agent doesn’t pick one.',
        `<select class="field" data-default-model>${modelOptions}</select>`)
        + row('Fallback', 'Used if the default provider is down.',
          `<select class="field" data-default-fallback>${fallbackOptions}</select>`)
        + row('Token caps', 'Monthly caps for each organization.',
          '<a class="btn sm" href="organization-settings.html#st=usage">Open Usage &amp; limits</a>'));
  }

  function desktopsHtml(d) {
    const pending = (d.pending || []).map((x) => {
      const who = `<span class="avatar sq">${ic('laptop')}</span>`
        + `<span class="t"><b>${esc(x.name)}</b>`
        + `<small>${esc(x.user)} · asked ${esc(when(x.requestedAt))}</small></span>`;
      const acts = btn('Approve', `data-desktop-approve="${esc(x.id)}"`, 'pri')
        + btn('Deny', `data-desktop-revoke="${esc(x.id)}" data-desktop-name="${esc(x.name)}"`, 'ghost');
      return `<div class="st-row"><div class="who">${who}</div><div class="r">${acts}</div></div>`;
    }).join('');
    const linked = (d.desktops || []).map((x) => [
      `<b>${esc(x.name)}</b>`,
      esc(x.user),
      esc(x.syncs || '—'),
      esc(x.lastSeenAt ? when(x.lastSeenAt) : 'Never'),
      btn('Revoke', `data-desktop-revoke="${esc(x.id)}" data-desktop-name="${esc(x.name)}"`, 'ghost'),
    ]);
    const rules = d.rules || {};
    const nothingWaiting = emptyRow('Nothing waiting', 'New Desktops show up here when they ask to link.');
    return card('Waiting for approval', pending || nothingWaiting,
      'New Desktops wait here until an admin approves them.', `<span class="cnt">${(d.pending || []).length}</span>`)
      + card('Desktops', linked.length ? table(['Desktop', 'Signed in as', 'Syncs', 'Last seen', ''], linked)
        : emptyRow('No Desktops linked yet', 'Link one from Sulla Desktop › Profile › Connect a server.'),
      'Sulla Desktops linked to this server as an organization.', btn('+ Link a Desktop', 'data-desktop-link', 'pri'))
      + card('Rules', row('New Desktops need an admin’s approval', 'Links wait in the queue above.',
        toggle(rules.requireApproval !== false, 'Require approval', 'data-rule="requireApproval"'))
        + row('Desktops can run this server’s workflows', 'Workflows pinned to a Desktop run when it’s online.',
          toggle(rules.runWorkflows === true, 'Run workflows', 'data-rule="runWorkflows"')));
  }

  function storageHtml(d) {
    const s = d.storage || {};
    const b = d.backups || {};
    const total = s.diskTotalGb || 0;
    const volumes = (s.volumes || []).map((v) => meter(esc(v.name), `${v.sizeGb} GB`, esc(v.unit || 'stored'),
      pct(v.sizeGb, total), esc(v.detail || ''), esc(v.source || ''))).join('');
    const restore = btn('Restore', later('Restore runs from the server for now'), 'ghost');
    const last = b.last
      ? `${esc(when(b.last.at))} · ${b.last.sizeGb} GB · ${esc(b.last.status || 'succeeded')}`
      : 'No backup has run yet.';
    return (volumes ? `<div class="meters">${volumes}</div>` : '')
      + card('Storage', row('Data folder', `<span class="mono">${esc(s.dataDir || '')}</span> · ${num(total)} GB disk`,
        btn('Change', later(INSTALLER))))
      + card('Backups', row('Nightly backup',
        `Every day at ${esc(b.time || '2:00 AM')} · keeps the last ${esc(b.keep ?? 14)}.`,
        toggle(b.nightly === true, 'Nightly backup', 'data-backup-nightly'))
        + row('Destination', `${esc(b.destination || 'This server’s data folder')} · encrypted with your key.`,
          btn('Edit', later('Other backup destinations arrive in a later release')))
        + row('Last backup', last, `${btn('Back up now', 'data-backup-run')}${restore}`));
  }

  function updatesHtml(d) {
    const latest = d.latest?.version;
    const upToDate = !latest || latest === d.version;
    const command = d.updateCommand ? row('Update command', 'Updates run on the server, as root.',
      `<span class="mono">${esc(d.updateCommand)}</span>`) : '';
    return card('Sulla Server', row('Installed', `${esc(d.version)} · ${esc(fmtDate(d.installedAt))}`,
      pill(upToDate ? 'Up to date' : `${latest} available`, upToDate ? 'ok' : 'warn'))
      + row('Channel', '',
        `<select class="field" ${later('Channels arrive in a later release')}><option>Stable</option></select>`)
      + row('Install updates automatically', 'Sundays at 3:00 AM. A backup runs first.',
        toggle(false, 'Install updates automatically', later('One-click updates arrive in a later release')))
      + command, '', btn('Check now', 'data-updates-check'))
      + card('Recent updates', (d.history || []).length
        ? table(['Version', 'Installed', 'What changed'], d.history.map((u) => [
          `<b class="mono">${esc(u.version)}</b>`, esc(fmtDate(u.installedAt)), esc(u.notes || '')]))
        : emptyRow('No update history yet', 'Updates installed on this server show up here.'));
  }

  function auditHtml(d) {
    const kinds = [
      ['all', 'All'],
      ['signin', 'Sign-ins'],
      ['admin', 'Admin'],
      ['agents', 'Agents'],
      ['vault', 'Vault'],
    ];
    const seg = kinds
      .map(([k, l]) => `<button data-audit="${k}" class="${state.auditKind === k ? 'on' : ''}">${l}</button>`)
      .join('');
    const rows = (d.events || []).map((e) => [
      esc(when(e.at)),
      `<b>${esc(e.who)}</b>`,
      esc(e.what),
      `<span class="muted">${esc(e.from)}</span>`,
    ]);
    const events = rows.length
      ? table(['When', 'Who', 'What', 'From'], rows)
      : emptyRow('No events', 'Nothing matches this filter yet.');
    return card('Events', events,
      'Every admin action, sign-in and agent permission change on this server.',
      `<div class="seg">${seg}</div>${btn('Export CSV', 'data-audit-export', 'ghost')}`);
  }

  const RENDER = {
    overview: overviewHtml,
    users: usersHtml,
    license: licenseHtml,
    domains: domainsHtml,
    signin: signinHtml,
    providers: providersHtml,
    desktops: desktopsHtml,
    storage: storageHtml,
    updates: updatesHtml,
    audit: auditHtml,
  };

  const SUBTITLES = {
    overview: (d) => `Sulla Server ${d?.edition || ''} · ${d?.host || location.host}`,
    users: () => 'Everyone with an account on this server, and the seats they use.',
    license: () => 'This server’s license key and what it allows.',
    domains: () => 'Where people and devices reach this server.',
    signin: () => 'How people sign in. New accounts are invite only.',
    providers: () => 'The model providers agents on this server use, with your own API keys.',
    desktops: () => 'Sulla Desktops linked to this server.',
    storage: () => 'Where this server keeps its data, and its backups.',
    updates: () => 'The installed version and how updates arrive.',
    audit: () => 'Admin, sign-in, agent and vault events across every organization.',
  };

  // ── Loading and rendering ─────────────────────────────────────────────
  function hashSection() {
    const s = new URLSearchParams(location.hash.replace(/^#/, '')).get('st');
    return s in SECTIONS ? s : 'overview';
  }

  function sectionPath(section) {
    if (section !== 'audit' || state.auditKind === 'all') return SECTIONS[section].path;
    return `${SECTIONS[section].path}?kind=${encodeURIComponent(state.auditKind)}`;
  }

  function frame(section, inner) {
    const d = state.data[section];
    const wide = SECTIONS[section].wide ? 'wide' : '';
    state.ctx.view.innerHTML = '<main class="settings-content"><header class="page-head">'
      + `<div><h1>${esc(SECTIONS[section].label)}</h1><p>${esc(SUBTITLES[section](d))}</p></div></header>`
      + `<div class="st-grid ${wide}" data-section-body>${inner}</div></main>`;
    return state.ctx.view.querySelector('[data-section-body]');
  }

  function render() {
    const section = state.section;
    state.ctx.shell.settingsNav(section);
    const d = state.data[section];
    if (!d) return;
    frame(section, RENDER[section](d));
    wire();
  }

  // Storage & backups reads two routes; every other section reads one.
  async function fetchSection(section) {
    const get = async (path) => {
      const res = await state.ctx.api.get(path);
      return res?.data ?? res;
    };
    if (section !== 'storage') return get(sectionPath(section));
    const [storage, backups] = await Promise.all([get('/server/v1/storage'), get('/server/v1/backups')]);
    return { storage, backups };
  }

  async function loadSection(section = state.section) {
    const body = frame(section, '');
    states.loading(body, `Loading ${SECTIONS[section].label.toLowerCase()}…`);
    try {
      state.data[section] = await fetchSection(section);
      if (section === state.section) render();
    } catch (error) {
      if (section !== state.section) return;
      const shown = error?.status === 403
        ? Object.assign(new Error('Only server admins can open Server administration.'), { status: 403 })
        : error;
      states.error(body, shown, {
        title: `${SECTIONS[section].label} could not load`,
        retry: () => loadSection(section),
      });
    }
  }

  // ── Actions ───────────────────────────────────────────────────────────
  async function act(button, work, done) {
    if (button) button.disabled = true;
    try {
      await work();
      if (done) shell.toast(done);
      await loadSection();
    } catch (error) {
      shell.toast(states.errorText(error) || error?.body?.error || error?.message || 'That didn’t work.');
      if (button?.isConnected) button.disabled = false;
    }
  }

  const send = (method, path, body) => state.ctx.api.send(method, path, body);

  // A small form dialog in the same modal style as Cloud's account dialogs. Resolves with the
  // field values, or null when cancelled.
  function formDialog({ title, body, fields, okLabel = 'Save' }) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'modal-backdrop open';
      const option = (f, o) => {
        const selected = o.value === f.value ? 'selected' : '';
        return `<option value="${esc(o.value)}" ${selected}>${esc(o.label)}</option>`;
      };
      const inputs = fields.map((f) => {
        const control = f.options
          ? `<select class="field" name="${f.name}">${f.options.map((o) => option(f, o)).join('')}</select>`
          : `<input class="field" name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value || '')}"`
            + ` placeholder="${esc(f.placeholder || '')}" autocomplete="off" ${f.required ? 'required' : ''}>`;
        return `<label>${esc(f.label)}${control}</label>`;
      }).join('');
      wrap.innerHTML = '<form class="action-modal st-dialog server-form" role="dialog" aria-modal="true">'
        + `<h2>${esc(title)}</h2>`
        + `${body ? `<p>${esc(body)}</p>` : ''}${inputs}`
        + '<div class="modal-actions"><button class="btn" type="button" data-cancel>Cancel</button>'
        + `<button class="btn pri" type="submit">${esc(okLabel)}</button></div></form>`;
      const close = (value) => {
        wrap.remove();
        resolve(value);
      };
      wrap.querySelector('[data-cancel]').onclick = () => close(null);
      wrap.addEventListener('click', (e) => {
        if (e.target === wrap) close(null);
      });
      wrap.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        close(Object.fromEntries(new FormData(e.target).entries()));
      });
      document.body.appendChild(wrap);
      wrap.querySelector('input, select')?.focus();
    });
  }

  async function showLogs(id, name) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop open';
    wrap.innerHTML = '<div class="action-modal st-dialog server-logs" role="dialog" aria-modal="true">'
      + `<h2>${esc(name)} logs</h2><pre class="mono" data-logs-body>Loading…</pre>`
      + '<div class="modal-actions"><button class="btn" type="button" data-cancel>Close</button></div></div>';
    wrap.querySelector('[data-cancel]').onclick = () => wrap.remove();
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) wrap.remove();
    });
    document.body.appendChild(wrap);
    const pre = wrap.querySelector('[data-logs-body]');
    try {
      const res = await state.ctx.api.get(`/server/v1/services/${encodeURIComponent(id)}/logs?tail=200`);
      const data = res?.data ?? res;
      const lines = Array.isArray(data?.lines) ? data.lines : String(data?.text ?? data ?? '').split('\n');
      pre.textContent = lines.join('\n') || 'No log lines.';
    } catch (error) {
      pre.textContent = states.errorText(error) || 'The logs could not load.';
    }
  }

  async function editProvider(id) {
    const d = state.data.providers || {};
    const known = d.providers || [];
    const current = known.find((p) => p.id === id);
    const local = id === 'ollama' || current?.kind === 'local';
    const values = await formDialog({
      title: current ? `${current.connected ? 'Edit' : 'Connect'} ${current.name}` : 'Add a provider',
      body: 'The key is stored in this server’s vault. Only its last four characters are ever shown.',
      fields: [
        ...(current ? [] : [{
          name: 'id',
          label: 'Provider',
          options: known.filter((p) => !p.connected).map((p) => ({ value: p.id, label: p.name })),
        }]),
        local
          ? {
            name: 'baseUrl',
            label: 'Server URL',
            value: current?.baseUrl || '',
            placeholder: 'http://10.0.1.20:11434',
            required: true,
          }
          : { name: 'apiKey', label: 'API key', type: 'password', placeholder: 'Paste the key', required: true },
      ],
    });
    if (!values) return;
    const target = id || values.id;
    const body = local ? { baseUrl: values.baseUrl } : { apiKey: values.apiKey };
    await act(null, () => send('PUT', `/server/v1/providers/${encodeURIComponent(target)}`, body), 'Provider saved.');
  }

  async function editSmtp() {
    const smtp = state.data.signin?.smtp || {};
    const values = await formDialog({
      title: 'Email delivery',
      body: 'Invitations and password resets are sent through this SMTP server.',
      fields: [
        { name: 'host', label: 'SMTP host', value: smtp.host || '', placeholder: 'smtp.example.com', required: true },
        { name: 'port', label: 'Port', value: String(smtp.port || 587), required: true },
        { name: 'username', label: 'Username', value: smtp.username || '' },
        {
          name: 'password',
          label: 'Password',
          type: 'password',
          placeholder: smtp.host ? 'Leave empty to keep the current one' : '',
        },
        {
          name: 'from',
          label: 'From address',
          value: smtp.from || '',
          placeholder: 'sulla@example.com',
          required: true,
        },
      ],
    });
    if (!values) return;
    const body = { ...values, port: Number(values.port) };
    if (!body.password) delete body.password;
    await act(null, () => send('PUT', '/server/v1/signin', { smtp: body }), 'Email delivery saved.');
  }

  function exportAudit() {
    const events = state.data.audit?.events || [];
    const quote = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const lines = [['when', 'who', 'kind', 'what', 'from'].join(',')]
      .concat(events.map((e) => [e.at, e.who, e.kind, e.what, e.from].map(quote).join(',')));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `sulla-server-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function wire() {
    const root = state.ctx.view;
    const on = (selector, handler) => root.querySelectorAll(selector).forEach((el) => {
      el.addEventListener(el.matches('input, select') ? 'change' : 'click', () => handler(el));
    });

    const enc = encodeURIComponent;
    const post = (path) => send('POST', path);
    const put = (path, body) => send('PUT', path, body);

    on('[data-audit]', (el) => {
      state.auditKind = el.dataset.audit;
      loadSection('audit');
    });
    on('[data-audit-export]', exportAudit);
    on('[data-logs]', (el) => showLogs(el.dataset.logs, el.dataset.logsName));
    on('[data-user-disable]', async (el) => {
      const yes = await shell.ask({
        title: `Suspend ${el.dataset.userName}?`,
        body: 'They’re signed out everywhere and can’t sign in until you restore them. Their seat is freed.',
        okLabel: 'Suspend',
        danger: true,
      });
      if (!yes) return;
      await act(el, () => post(`/server/v1/users/${enc(el.dataset.userDisable)}/disable`), 'Suspended.');
    });
    on('[data-user-enable]', (el) => {
      act(el, () => post(`/server/v1/users/${enc(el.dataset.userEnable)}/enable`), 'Restored.');
    });
    on('[data-resend]', (el) => {
      const path = `/teams/${enc(el.dataset.org)}/invitations/${enc(el.dataset.resend)}/resend`;
      act(el, () => post(path), 'Invitation sent again.');
    });
    on('[data-provider]', (el) => editProvider(el.dataset.provider));
    on('[data-default-model], [data-default-fallback]', (el) => {
      const body = {
        model: root.querySelector('[data-default-model]')?.value || null,
        fallback: root.querySelector('[data-default-fallback]')?.value || null,
      };
      act(el, () => put('/server/v1/providers/defaults', body), 'Defaults saved.');
    });
    on('[data-desktop-approve]', (el) => {
      act(el, () => post(`/server/v1/desktops/${enc(el.dataset.desktopApprove)}/approve`), 'Desktop approved.');
    });
    on('[data-desktop-revoke]', async (el) => {
      const yes = await shell.ask({
        title: `Disconnect ${el.dataset.desktopName}?`,
        body: 'Its sessions and relay tickets end now. It has to ask to link again.',
        okLabel: 'Disconnect',
        danger: true,
      });
      if (!yes) return;
      await act(el, () => post(`/server/v1/desktops/${enc(el.dataset.desktopRevoke)}/revoke`), 'Desktop disconnected.');
    });
    on('[data-desktop-link]', () => {
      const host = state.data.domains?.host || location.host;
      shell.ask({
        title: 'Link a Desktop',
        body: `In Sulla Desktop, open Profile › Connect a server and enter https://${host}. `
          + 'After the person signs in, the Desktop waits here for approval.',
        okLabel: 'Done',
      });
    });
    on('[data-rule]', (el) => {
      act(el, () => put('/server/v1/desktops/rules', { [el.dataset.rule]: el.checked }), 'Saved.');
    });
    on('[data-signin-twostep]', (el) => {
      act(el, () => put('/server/v1/signin', { requireTwoStep: el.checked }), 'Saved.');
    });
    on('[data-signin-days]', (el) => {
      act(el, () => put('/server/v1/signin', { invitationDays: Number(el.value) }), 'Saved.');
    });
    on('[data-smtp-edit]', editSmtp);
    on('[data-smtp-test]', (el) => act(el, () => post('/server/v1/signin/test-email'), 'Test email sent.'));
    on('[data-backup-nightly]', (el) => act(el, () => put('/server/v1/backups', { nightly: el.checked }), 'Saved.'));
    on('[data-backup-run]', (el) => act(el, () => post('/server/v1/backups/run'), 'Backup started.'));
    on('[data-updates-check]', () => loadSection('updates'));

    const search = root.querySelector('[data-user-search]');
    if (search) {
      search.addEventListener('input', () => {
        const at = search.selectionStart;
        state.userQuery = search.value;
        render();
        const next = state.ctx.view.querySelector('[data-user-search]');
        next.focus();
        next.setSelectionRange(at, at);
      });
    }
  }

  async function load(ctx) {
    state.ctx = ctx;
    state.section = hashSection();
    state.data = {};
    await loadSection();
  }

  window.addEventListener('hashchange', () => {
    if (!state.ctx) return;
    state.section = hashSection();
    if (state.data[state.section]) render();
    else loadSection();
  });
  shell.screen({ mount: load, reload: load, settings: 'server' });
})();
