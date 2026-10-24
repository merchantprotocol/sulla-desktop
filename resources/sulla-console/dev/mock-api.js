// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

// Sulla Server console, development only: synthetic data behind the real console pages, so they
// run without the Console API. dev/serve.mjs injects this script ahead of every other script
// when it runs with --mock; it is never part of the image. It answers the same /api routes and
// shapes the Console API serves (BUILD-PLAN.md section 1), with the approved mockup's data.
//
// <meta name="sulla-mock" content="server | signed-out">
//   server      signed in as the owner (default)
//   signed-out  the console's own sign-in card (dev/sign-in.html)
(function () {
  'use strict';

  const MODE = document.querySelector('meta[name="sulla-mock"]')?.content || 'server';
  const SERVER = true;
  const HOST = 'sulla.northwind.co';
  const BASE = `${location.origin}/api`;
  const LICENSE_KEY = 'sulla_mock_license';
  const CSRF_COOKIE = 'sulla-console-csrf';
  // calls: every API request the mock answered, for browser checks.
  window.SullaMock = { mode: MODE, server: SERVER, host: HOST, vaultHost: `vault.${HOST}`, calls: [] };

  // ── Session ─────────────────────────────────────────────────────────────
  // server-auth.js treats a readable CSRF cookie as "signed in". The dev server's fake
  // /accounts-api/v1/web/login sets it; signing out clears it.
  const setCsrf = (value, maxAge) => {
    document.cookie = `${CSRF_COOKIE}=${value}; path=/; max-age=${maxAge}; SameSite=Lax`;
  };
  try {
    if (MODE === 'signed-out') {
      setCsrf('', 0);
      sessionStorage.setItem('sulla_server_signed_out', '1');
    }
    // ?license=invalid shows the server with a lapsed license; ?license=valid restores it.
    const lic = new URLSearchParams(location.search).get('license');
    if (lic === 'invalid') localStorage.setItem(LICENSE_KEY, 'invalid');
    if (lic === 'valid') localStorage.removeItem(LICENSE_KEY);
  } catch (_) {
    // storage blocked: defaults apply
  }
  const licenseValid = () => {
    try {
      return localStorage.getItem(LICENSE_KEY) !== 'invalid';
    } catch (_) {
      return true;
    }
  };
  window.SullaMock.licenseValid = licenseValid;

  // ── Time helpers ────────────────────────────────────────────────────────
  const NOW = Date.now();
  const MIN = 60000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
  const ahead = (ms) => new Date(NOW + ms).toISOString();
  const day = (offset) => { const d = new Date(NOW - offset * DAY); return d.toISOString().slice(0, 10); };
  // Start of today, but never in the future: early-morning runs stay "today".
  const earlyToday = (minutesAfterMidnight) => { const d = new Date(); d.setHours(0, 0, 0, 0); const t = Math.min(d.getTime() + minutesAfterMidnight * MIN, NOW - 5 * MIN); return new Date(t).toISOString(); };

  // ── People and organizations ────────────────────────────────────────────
  const ME = { id: 'usr_jb', name: 'Jonathon Byrdziak', email: 'jonathon@northwind.co', color: '#3a7fa0', timezone: 'America/Los_Angeles', preferredName: 'Jonathon' };
  const ORGS = [
    { id: 'org_northwind', name: 'Northwind Roofing', role: 'owner', color: null, createdAt: '2026-10-02T16:20:00Z', planName: SERVER ? 'Sulla Server' : 'Team plan' },
    { id: 'org_gutters', name: 'Northwind Gutters & Siding', role: 'admin', color: null, createdAt: '2026-10-09T18:05:00Z', planName: SERVER ? 'Sulla Server' : 'Team plan' },
  ];
  let activeOrgId = (() => { try { return localStorage.getItem('sulla_team_id') || 'org_northwind'; } catch (_) { return 'org_northwind'; } })();
  if (!ORGS.some((o) => o.id === activeOrgId)) activeOrgId = 'org_northwind';

  const MEMBERS = [
    ['usr_jb', 'Jonathon Byrdziak', 'jonathon@northwind.co', 'owner', 22, 0],
    ['usr_so', 'Sam Ortiz', 'sam@northwind.co', 'admin', 22, 0.1],
    ['usr_rk', 'Ray King', 'ray@northwind.co', 'member', 19, 0.4],
    ['usr_lm', 'Lena Morris', 'lena@northwind.co', 'member', 15, 1],
    ['usr_mc', 'Maria Chen', 'maria@northwind.co', 'member', 15, 0.2],
    ['usr_dp', 'Diego Pérez', 'diego@northwind.co', 'member', 14, 2],
    ['usr_ah', 'Aisha Hassan', 'aisha@northwind.co', 'member', 12, 0.3],
    ['usr_tw', 'Tom Walsh', 'tom@northwind.co', 'member', 12, 5],
    ['usr_ks', 'Kara Singh', 'kara@northwind.co', 'member', 10, 1],
    ['usr_bn', 'Ben Novak', 'ben@northwind.co', 'member', 9, 3],
    ['usr_ef', 'Emma Fischer', 'emma@northwind.co', 'member', 8, 0.5],
    ['usr_jl', 'Jamal Lewis', 'jamal@northwind.co', 'member', 6, 1],
    ['usr_nr', 'Nina Rossi', 'nina@northwind.co', 'member', 4, 2],
    ['usr_ph', 'Paul Hughes', 'paul@northwind.co', 'member', 2, 1],
  ].map(([id, name, email, role, joinedDays, activeDays]) => ({ userId: id, name, email, role, joinedAt: iso(joinedDays * DAY), lastActiveAt: iso(activeDays * DAY), isPayer: role === 'owner' }));
  const GUTTER_MEMBERS = [
    { userId: 'usr_op', name: 'Owen Park', email: 'owen@northwindgutters.co', role: 'owner', joinedAt: iso(15 * DAY), lastActiveAt: iso(HOUR) },
    { userId: 'usr_jb', name: 'Jonathon Byrdziak', email: 'jonathon@northwind.co', role: 'admin', joinedAt: iso(15 * DAY), lastActiveAt: iso(0) },
    { userId: 'usr_vg', name: 'Vera Gomez', email: 'vera@northwindgutters.co', role: 'member', joinedAt: iso(11 * DAY), lastActiveAt: iso(DAY) },
    { userId: 'usr_lt', name: 'Luis Torres', email: 'luis@northwindgutters.co', role: 'member', joinedAt: iso(7 * DAY), lastActiveAt: iso(2 * DAY) },
  ];
  const INVITES = [
    { id: 'inv_dw', email: 'dana@northwind.co', role: 'member', status: 'pending', expiresAt: ahead(5 * DAY), inviterName: 'Sam Ortiz', inviteUrl: `https://${HOST}/invite/accept.html?invite=inv_dw` },
    { id: 'inv_cr', email: 'chris@northwind.co', role: 'member', status: 'expired', expiresAt: iso(2 * DAY), inviterName: 'Jonathon Byrdziak', inviteUrl: `https://${HOST}/invite/accept.html?invite=inv_cr` },
  ];
  const membersOf = (id) => (id === 'org_gutters' ? GUTTER_MEMBERS : MEMBERS);

  function profile() {
    return {
      ...ME,
      activeTeamId: activeOrgId,
      memberships: ORGS.map((o) => ({ teamId: o.id, teamName: o.name, role: o.role })),
      isSuperAdmin: false,
      isServerAdmin: true,
    };
  }

  // ── Devices ─────────────────────────────────────────────────────────────
  const DEVICES = [
    { id: 'dev_mbp', name: 'Jonathon’s MacBook Pro', deviceType: 'desktop', platform: 'macOS 26.1', model: 'MacBook Pro', appVersion: '1.6.1', online: true, lastSeenAt: iso(MIN), syncSettings: { workflows: true, agents: true, chats: true, files: true, usage: true } },
    { id: 'dev_mini', name: 'Office Mac mini', deviceType: 'desktop', platform: 'macOS 26.1', model: 'Mac mini', appVersion: '1.6.1', online: true, lastSeenAt: iso(MIN), syncSettings: { workflows: true, agents: true, recipes: true, usage: true } },
    { id: 'dev_iphone', name: 'Jonathon’s iPhone', deviceType: 'mobile', platform: 'iOS 26', model: 'iPhone', appVersion: '1.0.0', online: true, lastSeenAt: iso(3 * MIN) },
    { id: 'dev_air', name: 'Sam’s MacBook Air', deviceType: 'desktop', platform: 'macOS 26.0', model: 'MacBook Air', appVersion: '1.6.0', online: false, lastSeenAt: iso(19 * HOUR), syncSettings: { workflows: true, usage: true } },
    { id: 'dev_pc', name: 'Estimating PC', deviceType: 'desktop', platform: 'Windows 11', model: 'PC', appVersion: '1.5.4', online: false, lastSeenAt: iso(41 * DAY) },
  ];
  const deviceName = (id) => DEVICES.find((d) => d.id === id)?.name || 'Device';
  const devPlace = (id) => { const d = DEVICES.find((x) => x.id === id); return { kind: 'device', deviceId: id, deviceName: d.name, online: d.online, freshness: d.online ? 'live' : 'offline' }; };
  const HERE = { kind: 'cloud', deviceName: SERVER ? 'Sulla Server' : 'Sulla Cloud', online: true };

  // ── Agents ──────────────────────────────────────────────────────────────
  const ctl = (place, ok = true) => ({ message: ok, stop: ok, transport: place.kind === 'cloud' ? 'cloud' : 'signed-desktop-channel' });
  const AGENTS = [
    { id: 'ag_1', jobId: 'job_1', agentId: 'estimator', label: 'Estimator', state: 'running', currentTask: 'Pricing the 1142 Alder St reroof from the drone survey', activity: 'Measuring roof planes', progress: 62, elapsedMs: 18 * MIN, placement: HERE },
    { id: 'ag_2', jobId: 'job_2', agentId: 'lead-intake', label: 'Lead intake', state: 'waiting', currentTask: 'Confirm the inspection slot for the Hartley residence', activity: 'Waiting on Jonathon', progress: 80, elapsedMs: 42 * MIN, placement: HERE },
    { id: 'ag_3', jobId: 'job_3', agentId: 'storm-responder', label: 'Storm responder', state: 'running', currentTask: 'Texting homeowners in the Oct 23 hail path', activity: 'Sent 38 of 112 messages', progress: 34, elapsedMs: 55 * MIN, placement: HERE },
    { id: 'ag_4', jobId: 'job_4', agentId: 'supplier-watch', label: 'Supplier price watch', state: 'running', currentTask: 'Comparing ABC Supply and SRS shingle prices', activity: 'Reading supplier portals', progress: 45, elapsedMs: 9 * MIN, placement: devPlace('dev_mini'), taskIndex: 0 },
    { id: 'ag_5', jobId: 'job_5', agentId: 'permit-tracker', label: 'Permit tracker', state: 'stuck', currentTask: 'Checking Boise permit portal for 3 open jobs', activity: 'No check-in for 14 minutes', progress: 20, elapsedMs: 31 * MIN, placement: devPlace('dev_mini'), taskIndex: 0 },
    { id: 'ag_6', jobId: 'job_6', agentId: 'sulla', label: 'Sulla', state: 'running', currentTask: 'Drafting the crew safety memo', activity: 'Writing section 3 of 5', progress: 58, elapsedMs: 6 * MIN, placement: devPlace('dev_mbp'), taskIndex: 0 },
    { id: 'ag_7', jobId: 'job_7', agentId: 'invoice-chaser', label: 'Invoice chaser', state: 'paused', currentTask: 'Reminders for 4 invoices over 30 days', activity: 'Paused by Sam Ortiz', progress: null, elapsedMs: null, placement: HERE },
  ].map((a) => ({ ...a, controls: ctl(a.placement, a.state !== 'paused') }));

  // ── Workflows ───────────────────────────────────────────────────────────
  const runSeq = (pattern, everyMs, startMs = 0) => pattern.split('').map((c, i) => ({ executionId: null, outcome: { o: 'ok', f: 'failed', r: 'running' }[c], startedAt: iso(startMs + i * everyMs) }));
  function wf(id, name, description, status, place, trigger, pattern, everyMs, startMs, next) {
    const runs = runSeq(pattern, everyMs, startMs).map((r, i) => ({ ...r, executionId: `run_${id}_${i}`, trigger: trigger.kind === 'schedule' ? 'Schedule' : trigger.label }));
    return { id: place.kind === 'cloud' ? `cloud:${id}` : `device:${place.deviceId}:${id}`, slug: id, name, description, status, placement: place, trigger, runs, nextRunAt: next, nextRunOn: next ? null : (status === 'waiting' ? 'When the device is online' : null) };
  }
  const WORKFLOWS = [
    wf('lead-sync', 'Nightly lead sync', 'Pulls new web and phone leads into the CRM and assigns an estimator.', 'active', HERE, { kind: 'schedule', label: 'Daily 6:00 AM' }, 'oooooooooooo', DAY, Math.max(10 * MIN, NOW - new Date(earlyToday(360)).getTime()), ahead(16 * HOUR)),
    wf('storm-outreach', 'Storm alert outreach', 'When a hail or wind alert covers our area, texts past customers in the path.', 'active', HERE, { kind: 'webhook', label: 'Weather alert' }, 'roofooooooo', 2 * DAY, 55 * MIN, null),
    wf('estimate-followups', 'Estimate follow-ups', 'Follows up on estimates with no reply after 3 days.', 'active', HERE, { kind: 'schedule', label: 'Weekdays 9:00 AM' }, 'ooooofoooooo', DAY, Math.max(20 * MIN, NOW - new Date(earlyToday(540)).getTime()), ahead(20 * HOUR)),
    wf('price-check', 'Supplier price check', 'Checks shingle, underlayment and flashing prices at two suppliers.', 'active', devPlace('dev_mini'), { kind: 'schedule', label: 'Every 4 hours' }, 'rooooooooooo', 4 * HOUR, 9 * MIN, ahead(3 * HOUR + 51 * MIN)),
    wf('crew-schedule', 'Weekly crew schedule', 'Builds next week’s crew schedule from booked jobs and the forecast.', 'active', devPlace('dev_mini'), { kind: 'schedule', label: 'Mondays 7:00 AM' }, 'oooooooooooo', 7 * DAY, 5 * DAY, ahead(2 * DAY + 17 * HOUR)),
    wf('review-requests', 'Review requests', 'Asks happy customers for a Google review a day after the job closes.', 'waiting', devPlace('dev_air'), { kind: 'event', label: 'Job closed' }, 'ooofoooooooo', DAY, 20 * HOUR, null),
    wf('permit-status', 'Permit status check', 'Checks the city permit portal and updates each job.', 'paused', HERE, { kind: 'schedule', label: 'Daily 8:00 AM' }, 'fffooooooooo', DAY, 3 * DAY, null),
  ];
  const RUN_DETAIL = (id) => {
    const w = WORKFLOWS.find((x) => x.runs.some((r) => r.executionId === id)) || WORKFLOWS[0];
    const r = w.runs.find((x) => x.executionId === id) || w.runs[0];
    const started = new Date(r.startedAt).getTime();
    const at = (s) => new Date(started + s * 1000).toISOString();
    const failed = r.outcome === 'failed';
    const steps = w.slug === 'storm-outreach'
      ? [{ label: 'Weather alert received', subtype: 'trigger', at: at(0), output: 'NWS hail warning · Ada County · 1.25 in hail' }, { label: 'Find customers in the path', subtype: 'agent', at: at(14), output: '112 past customers inside the warning polygon' }, { label: 'Draft text messages', subtype: 'agent', at: at(41), output: '112 drafts · tone: helpful, no pressure' }, ...(failed ? [{ label: 'Send through Twilio', subtype: 'integration', at: at(63), output: 'Twilio returned 401 Unauthorized' }] : [{ label: 'Send through Twilio', subtype: 'integration', at: at(63), output: r.outcome === 'running' ? '38 of 112 sent' : '112 sent · 0 failed' }])]
      : [{ label: 'Start', subtype: 'trigger', at: at(0), output: w.trigger.label }, { label: 'Load records', subtype: 'function', at: at(6), output: '24 records loaded' }, { label: 'Agent step', subtype: 'agent', at: at(48), output: failed ? null : 'Updated 9 records · assigned 3 estimators' }, ...(failed ? [] : [{ label: 'Notify the team', subtype: 'integration', at: at(52), output: 'Posted summary to #estimating' }])];
    return { id, workflowName: w.name, outcome: r.outcome, startedAt: r.startedAt, completedAt: r.outcome === 'running' ? null : at(failed ? 63 : 70), lastActivityAt: at(63), placement: w.placement, trigger: r.trigger, steps, error: failed ? (w.slug === 'storm-outreach' ? 'Send through Twilio: 401 Unauthorized. The Twilio key in Passwords may have been rotated.' : 'The agent step timed out after 10 minutes.') : null };
  };

  // ── Chats ───────────────────────────────────────────────────────────────
  const CHATS = [
    { id: 'chat_hartley', title: 'Hail damage claim · Hartley residence', last_message_preview: 'I drafted the claim packet. It needs the adjuster’s name before it goes out.', last_message_at: iso(12 * MIN), created_at: iso(2 * HOUR), unread_count: 1 },
    { id: 'chat_pricing', title: 'Q4 shingle pricing', last_message_preview: 'GAF Timberline HDZ is up 4.2% at ABC Supply since September.', last_message_at: iso(3 * HOUR), created_at: iso(DAY), unread_count: 0 },
    { id: 'chat_safety', title: 'Crew safety memo', last_message_preview: 'Here’s the outline: fall protection, ladder setup, heat, and storm call-outs.', last_message_at: iso(26 * HOUR), created_at: iso(27 * HOUR), unread_count: 0, device_id: 'dev_mbp', device_name: 'Jonathon’s MacBook Pro', origin: 'desktop' },
    { id: 'chat_warranty', title: 'GAF vs Owens Corning warranties', last_message_preview: 'Both cover wind to 130 mph with the right starter strip and nailing pattern.', last_message_at: iso(3 * DAY), created_at: iso(3 * DAY), unread_count: 0 },
    { id: 'chat_hiring', title: 'Job post for a roofing foreman', last_message_preview: 'Posted to Indeed and our careers page.', last_message_at: iso(6 * DAY), created_at: iso(6 * DAY), unread_count: 0 },
  ];
  const LINKED = [
    { id: 'link_hoa', title: 'Bid for Lakeside HOA (42 units)', device_id: 'dev_mbp', device_name: 'Jonathon’s MacBook Pro', remote_conversation_id: 'conv_hoa', last_seen_at: iso(MIN), updated_at: iso(5 * HOUR), last_message_preview: '', privacy_mode: 'metadata_only', upload_cursor: 18, offline_policy: 'ask', unread_count: 0 },
  ];
  const MESSAGES = {
    chat_hartley: [
      ['user', 'The Hartleys at 418 Juniper Ct had hail damage on Oct 23. Can you start the insurance claim packet? Photos are in Files › Insurance claims › Hartley.', 125],
      ['assistant', 'Started. I found 46 photos and the drone survey from Oct 23.\n\n**What I see so far**\n- Hail strikes on the north and west planes, about 9 per test square\n- Two cracked ridge caps\n- Dented gutters on the north side\n\nDo you want the packet to include the gutter damage, or only the roof?', 118],
      ['user', 'Include the gutters. Their carrier is State Farm.', 40],
      ['assistant', 'Done. The packet has:\n\n1. Cover letter to State Farm\n2. Damage summary with marked-up photos\n3. Xactimate-style line items, **$18,420** before tax\n4. The drone survey report\n\nI saved it to **Files › Insurance claims › Hartley**. It needs the adjuster’s name before it goes out.', 12],
    ],
    chat_pricing: [
      ['user', 'What changed in shingle pricing this quarter?', 200],
      ['assistant', 'GAF Timberline HDZ is up **4.2%** at ABC Supply since September. SRS is up 2.8%. Owens Corning Duration didn’t change at either supplier.', 180],
    ],
    chat_safety: [
      ['user', 'Draft a one-page safety memo for the crews before the storm season.', 1570],
      ['assistant', 'Here’s the outline: fall protection, ladder setup, heat, and storm call-outs. Want me to write it out?', 1560],
    ],
    chat_warranty: [
      ['user', 'Compare GAF and Owens Corning wind warranties.', 4330],
      ['assistant', 'Both cover wind to 130 mph with the right starter strip and nailing pattern.', 4320],
    ],
    chat_hiring: [
      ['user', 'Write a job post for a roofing foreman.', 8650],
      ['assistant', 'Posted to Indeed and our careers page.', 8640],
    ],
  };

  // ── Files (the organization's files) ────────────────────────────────────
  const FOLDERS = ['Estimates', 'Insurance claims', 'Job photos', 'Contracts', 'Marketing', 'Safety', 'Suppliers'];
  const fromServer = { deviceId: null, deviceType: 'cloud' };
  const fromDev = (id) => { const d = DEVICES.find((x) => x.id === id); return { deviceId: id, deviceName: d.name, deviceType: d.deviceType, online: d.online }; };
  let fileSeq = 0;
  const F = (name, path, opts) => ({ id: opts.id || `f_${++fileSeq}`, name, path: path ? `${path}/${name}` : name, parentPath: path || '', kind: 'file', itemType: opts.doc ? 'document' : 'file', mime: opts.mime || (opts.doc ? 'text/markdown' : 'application/octet-stream'), sizeBytes: opts.size ?? null, modifiedAt: iso(opts.ago), ownerName: opts.owner || 'Jonathon Byrdziak', ownerUserId: opts.ownerId || (opts.owner && opts.owner !== 'Jonathon Byrdziak' ? 'usr_x' : 'usr_jb'), cameFrom: opts.from || fromServer, shared: !!opts.shared, storedInCloud: true });
  const FILES = [
    ...FOLDERS.map((name, i) => ({ id: `fd_${i}`, name, path: name, parentPath: '', kind: 'folder', itemType: 'folder', modifiedAt: iso([2 * HOUR, 12 * MIN, 5 * HOUR, 2 * DAY, 4 * DAY, 26 * HOUR, 3 * DAY][i]), ownerName: ['Ray King', 'Jonathon Byrdziak', 'Tom Walsh', 'Sam Ortiz', 'Lena Morris', 'Jonathon Byrdziak', 'Maria Chen'][i], cameFrom: fromServer, shared: i === 1 })),
    F('Crew safety handbook 2026', '', { doc: true, size: 48200, ago: 26 * HOUR, id: 'doc_safety', shared: true }),
    F('Storm season playbook', '', { doc: true, size: 21900, ago: 3 * DAY, owner: 'Sam Ortiz', id: 'doc_storm' }),
    F('Q4 price sheet.csv', '', { mime: 'text/csv', size: 186000, ago: 3 * HOUR, owner: 'Maria Chen', from: fromDev('dev_mini') }),
    F('Northwind service area.pdf', '', { mime: 'application/pdf', size: 2400000, ago: 9 * DAY, owner: 'Lena Morris' }),
    F('Logo pack.zip', '', { mime: 'application/zip', size: 14800000, ago: 20 * DAY, owner: 'Lena Morris', from: fromDev('dev_mbp') }),
    F('Hartley · claim packet', 'Insurance claims', { doc: true, size: 31200, ago: 12 * MIN, id: 'doc_hartley', shared: true }),
    F('Hartley · drone survey.pdf', 'Insurance claims', { mime: 'application/pdf', size: 8200000, ago: 26 * HOUR, owner: 'Tom Walsh', from: fromDev('dev_mbp') }),
    F('Hartley · north plane.jpg', 'Insurance claims', { mime: 'image/jpeg', size: 3100000, ago: 26 * HOUR, owner: 'Tom Walsh' }),
    F('Hartley · ridge cap.jpg', 'Insurance claims', { mime: 'image/jpeg', size: 2900000, ago: 26 * HOUR, owner: 'Tom Walsh' }),
    F('State Farm adjuster notes.pdf', 'Insurance claims', { mime: 'application/pdf', size: 410000, ago: 2 * DAY, owner: 'Aisha Hassan' }),
    F('1142 Alder St · estimate', 'Estimates', { doc: true, size: 12800, ago: 2 * HOUR, owner: 'Ray King', id: 'doc_alder' }),
    F('Lakeside HOA · bid.pdf', 'Estimates', { mime: 'application/pdf', size: 920000, ago: 5 * HOUR, from: fromDev('dev_mbp') }),
    F('Juniper Ct · estimate.pdf', 'Estimates', { mime: 'application/pdf', size: 380000, ago: 4 * DAY, owner: 'Ray King' }),
    F('Alder St · drone 01.jpg', 'Job photos', { mime: 'image/jpeg', size: 5200000, ago: 5 * HOUR, owner: 'Tom Walsh', from: fromDev('dev_iphone') }),
    F('Alder St · walkthrough.mov', 'Job photos', { mime: 'video/quicktime', size: 184000000, ago: 5 * HOUR, owner: 'Tom Walsh', from: fromDev('dev_iphone') }),
    F('Master service agreement.pdf', 'Contracts', { mime: 'application/pdf', size: 260000, ago: 30 * DAY, owner: 'Sam Ortiz' }),
    F('Fall season mailer.pdf', 'Marketing', { mime: 'application/pdf', size: 3400000, ago: 4 * DAY, owner: 'Lena Morris' }),
    F('Ladder setup checklist', 'Safety', { doc: true, size: 6400, ago: 26 * HOUR, id: 'doc_ladder' }),
    F('ABC Supply · October invoice.pdf', 'Suppliers', { mime: 'application/pdf', size: 120000, ago: 3 * DAY, owner: 'Maria Chen' }),
  ];
  const DOCS = {
    doc_safety: { title: 'Crew safety handbook 2026', content: '# Crew safety handbook 2026\n\nEvery crew member reads this before their first job of the season.\n\n## Fall protection\n\n- Tie off above 6 feet, every time.\n- Inspect harnesses and lanyards each morning.\n\n## Ladders\n\n- Set ladders at a 4:1 angle and extend 3 feet past the eave.\n- Secure the top before anyone climbs.\n\n## Heat\n\n- Water every 20 minutes when it’s over 85°F.\n- Crew leads call breaks; nobody needs to ask.\n\n## Storms\n\nStop work when lightning is within 10 miles. The Storm responder agent texts every crew lead when a warning covers a job site.\n' },
    doc_storm: { title: 'Storm season playbook', content: '# Storm season playbook\n\n1. Watch for alerts.\n2. Text past customers in the path.\n3. Book inspections within 48 hours.\n' },
    doc_hartley: { title: 'Hartley · claim packet', content: '# Hartley residence · hail claim\n\n**Carrier:** State Farm  \n**Date of loss:** Oct 23, 2026\n\n## Damage summary\n\n- Hail strikes on the north and west planes, about 9 per test square\n- Two cracked ridge caps\n- Dented gutters on the north side\n\n## Estimate\n\n$18,420 before tax.\n' },
    doc_alder: { title: '1142 Alder St · estimate', content: '# 1142 Alder St · reroof\n\n- Tear-off, 1 layer: 28 squares\n- GAF Timberline HDZ, Charcoal\n- Ice and water shield at eaves and valleys\n' },
    doc_ladder: { title: 'Ladder setup checklist', content: '# Ladder setup checklist\n\n- [ ] 4:1 angle\n- [ ] 3 feet past the eave\n- [ ] Top secured\n' },
  };
  const fileById = (id) => FILES.find((f) => f.id === id);
  const fileDetail = (f) => ({ ...f, access: f.shared ? [{ grantId: 'g_1', scope: 'org', teamName: currentOrg().name }] : [], links: f.id === 'f_3' ? [{ linkId: 'l_1', url: '/s/7Hq2xLk' }] : [] });

  // ── Use Cases ───────────────────────────────────────────────────────────
  const T = (id, title, line, topic, author, featured, manifest, extra = {}) => ({ id, name: title, title, line, description: line, topic, author_display: author, featured, manifest, version: extra.version || '1.0.0', updated_at: extra.updated || '2026-10-14 17:00:00', download_count: extra.installs || 0, bundle_size: extra.size || 184000, app: extra.app || 'none', kind: 'package', kind_label: 'Package' });
  const TEMPLATES = [
    T('uc_storm', 'Storm lead responder', 'Watches weather alerts and texts past customers in the storm path within minutes.', 'sales', 'Merchant Protocol', true, { agents: 1, workflows: 2, integrations: 1, description_md: 'When the National Weather Service issues a hail or wind warning, **Storm lead responder** finds past customers inside the warning area and texts them an offer for a free inspection.\n\n- Works with Twilio for texts\n- Books inspections into your calendar\n- Stops after one message per storm' }, { version: '2.1.0', installs: 412 }),
    T('uc_estimate', 'Estimate builder', 'Turns inspection photos and a drone survey into a priced estimate.', 'operations', 'Merchant Protocol', true, { agents: 1, skills: 3, workflows: 1 }, { version: '1.4.2', installs: 958, app: 'dashboard' }),
    T('uc_reviews', 'Review request autopilot', 'Asks happy customers for a Google review a day after the job closes.', 'sales', 'Ridgeline Labs', true, { workflows: 2, integrations: 1 }, { version: '1.2.0', installs: 1630 }),
    T('uc_receptionist', 'AI receptionist', 'Answers calls, books inspections and texts confirmations.', 'sales', 'Merchant Protocol', false, { agents: 2, workflows: 3, integrations: 2 }, { version: '1.5.0', installs: 2210 }),
    T('uc_invoices', 'Invoice chaser', 'Polite reminders until invoices are paid, synced with QuickBooks.', 'finance', 'Ledgerly', false, { workflows: 1, integrations: 1 }, { version: '0.9.4', installs: 744 }),
    T('uc_permits', 'Permit tracker', 'Checks city permit portals and updates each job.', 'operations', 'Merchant Protocol', false, { agents: 1, workflows: 1, functions: 2 }, { version: '1.0.3', installs: 288 }),
    T('uc_crews', 'Crew scheduler', 'Builds next week’s crew schedule from booked jobs and the forecast.', 'operations', 'Fieldwise', false, { agents: 1, workflows: 1, recipes: 1 }, { version: '2.0.0', installs: 391, app: 'dashboard' }),
    T('uc_suppliers', 'Supplier price watch', 'Compares material prices across your suppliers every few hours.', 'finance', 'Merchant Protocol', false, { agents: 1, workflows: 1, skills: 1 }, { version: '1.1.0', installs: 205 }),
    T('uc_network', 'Network watch', 'SullaWorks sentry and hub for your office network.', 'it', 'Merchant Protocol', false, { recipes: 2 }, { version: '0.3.0', installs: 96, app: 'dashboard' }),
  ];
  const TOPICS = [{ key: 'sales', label: 'Sales & marketing', count: 3 }, { key: 'operations', label: 'Operations', count: 3 }, { key: 'finance', label: 'Finance', count: 2 }, { key: 'it', label: 'IT & security', count: 1 }];
  const KINDS = [['agent', 'Agent', 'Agents'], ['skill', 'Skill', 'Skills'], ['routine', 'Workflow', 'Workflows'], ['workflow', 'Workflow', 'Workflows'], ['function', 'Function', 'Functions'], ['integration', 'Integration', 'Integrations'], ['recipe', 'Recipe', 'Recipes'], ['package', 'Package', 'Packages']].map(([kind, singular, plural]) => ({ kind, singular, plural }));
  const LIBRARY = [
    { templateId: 'uc_storm', name: 'Storm lead responder', kind: 'package', updateAvailable: true, cloud: true, devices: [] },
    { templateId: 'uc_estimate', name: 'Estimate builder', kind: 'package', updateAvailable: false, cloud: true, devices: [{ deviceId: 'dev_mbp', name: 'Jonathon’s MacBook Pro', status: 'active', deviceType: 'desktop', online: true }] },
    { templateId: 'uc_suppliers', name: 'Supplier price watch', kind: 'package', updateAvailable: false, cloud: false, devices: [{ deviceId: 'dev_mini', name: 'Office Mac mini', status: 'active', deviceType: 'desktop', online: true }] },
    { templateId: 'uc_reviews', name: 'Review request autopilot', kind: 'package', updateAvailable: true, cloud: false, devices: [{ deviceId: 'dev_air', name: 'Sam’s MacBook Air', status: 'queued', deviceType: 'desktop', online: false }] },
  ];
  function partsFor(t) {
    const m = t.manifest || {};
    const names = {
      agent: ['Storm dispatcher', 'Estimator', 'Front desk', 'Scheduler'], skill: ['Roof measurement', 'Line-item pricing', 'Photo markup'], routine: ['Alert intake', 'Customer outreach', 'Follow-up'], function: ['Portal login', 'Status parser'], integration: ['Twilio', 'Google Business Profile', 'QuickBooks'], recipe: ['Dashboard container', 'Sentry'],
    };
    const out = [];
    [['agent', m.agents], ['skill', m.skills], ['routine', m.workflows], ['function', m.functions], ['integration', m.integrations], ['recipe', m.recipes]].forEach(([kind, n]) => { for (let i = 0; i < (n || 0); i++) out.push({ kind, name: names[kind][i % names[kind].length], action: 'install' }); });
    return out;
  }
  function review(t, targets) {
    const parts = partsFor(t);
    return { targets: targets.map((key) => ({ key, parts: parts.map((p) => ({ ...p, action: p.kind === 'recipe' && key === 'cloud' ? 'skip' : 'install' })) })), hasDesktopOnlyParts: parts.some((p) => p.kind === 'recipe') };
  }

  // ── Studio catalog (synced from Desktops) ───────────────────────────────
  const SKILLS = [
    { slug: 'roof-measure', name: 'Roof measurement', description: 'Measures roof planes and pitch from a drone survey or satellite image.', category: 'Estimating', promptLength: 4120, content: 'You measure roofs.\n\n1. Find every plane in the survey.\n2. Report pitch, area in squares and waste factor.\n3. Flag anything you could not measure.', deviceId: 'dev_mbp', deviceName: 'Jonathon’s MacBook Pro', syncedAt: iso(10 * MIN), updatedAt: iso(3 * DAY), source: 'Desktop' },
    { slug: 'line-items', name: 'Line-item pricing', description: 'Prices tear-off, materials and labor from the current price sheet.', category: 'Estimating', promptLength: 2980, deviceId: 'dev_mbp', deviceName: 'Jonathon’s MacBook Pro', syncedAt: iso(10 * MIN), updatedAt: iso(5 * DAY), source: 'Use case · Estimate builder' },
    { slug: 'claim-letter', name: 'Insurance claim letter', description: 'Writes a cover letter to the carrier with the damage summary.', category: 'Insurance', promptLength: 1870, deviceId: 'dev_mini', deviceName: 'Office Mac mini', syncedAt: iso(12 * MIN), updatedAt: iso(9 * DAY), source: 'Desktop' },
    { slug: 'crew-brief', name: 'Morning crew brief', description: 'Turns the day’s jobs and forecast into a two-minute brief.', category: 'Operations', promptLength: 960, draft: true, deviceId: 'dev_mini', deviceName: 'Office Mac mini', syncedAt: iso(12 * MIN), updatedAt: iso(DAY), source: 'Desktop' },
  ];
  const CUSTOM_AGENTS = [
    { slug: 'estimator', name: 'Estimator', description: 'Prices reroofs and repairs from photos and surveys.', provider: 'Anthropic', model: 'Claude Sonnet 5.5', skills: ['Roof measurement', 'Line-item pricing'], prompt: 'You are Northwind Roofing’s estimator…', deviceId: 'dev_mbp', deviceName: 'Jonathon’s MacBook Pro', syncedAt: iso(10 * MIN), updatedAt: iso(4 * DAY), source: 'Desktop' },
    { slug: 'lead-intake', name: 'Lead intake', description: 'Qualifies new leads and books inspections.', provider: 'Anthropic', model: 'Claude Haiku 5.5', skills: ['Morning crew brief'], prompt: 'You answer new leads for Northwind Roofing…', deviceId: 'dev_mini', deviceName: 'Office Mac mini', syncedAt: iso(12 * MIN), updatedAt: iso(6 * DAY), source: 'Desktop' },
    { slug: 'storm-responder', name: 'Storm responder', description: 'Contacts customers after hail and wind alerts.', provider: 'Anthropic', model: 'Claude Sonnet 5.5', skills: [], prompt: 'When a storm alert arrives…', deviceId: 'dev_mini', deviceName: 'Office Mac mini', syncedAt: iso(12 * MIN), updatedAt: iso(2 * DAY), source: 'Use case · Storm lead responder' },
  ];
  const RECIPES = [
    { slug: 'estimate-dashboard', name: 'Estimate dashboard', description: 'Web dashboard for open estimates and win rates.', version: '1.4.2', running: true, containers: [{ service: 'web', status: 'running', ports: ['8420:80'] }, { service: 'db', status: 'running', ports: [] }], deviceId: 'dev_mini', deviceName: 'Office Mac mini', syncedAt: iso(12 * MIN), updatedAt: iso(9 * DAY), source: 'Use case · Estimate builder' },
    { slug: 'sullaworks', name: 'Network watch', description: 'SullaWorks sentry and hub for the office network.', version: '0.3.0', running: true, containers: [{ service: 'sullaworks-hub', status: 'running', ports: ['8770:8770'] }, { service: 'sullaworks-sentry', status: 'running', ports: [] }], deviceId: 'dev_mini', deviceName: 'Office Mac mini', syncedAt: iso(12 * MIN), updatedAt: iso(2 * DAY), source: 'Use case · Network watch' },
    { slug: 'ollama', name: 'Local models', description: 'Ollama with Qwen and Llama models for private work.', version: '0.12.4', running: false, containers: [{ service: 'ollama', status: 'exited', ports: ['11434:11434'] }], deviceId: 'dev_mbp', deviceName: 'Jonathon’s MacBook Pro', syncedAt: iso(10 * MIN), updatedAt: iso(12 * DAY), source: 'Desktop' },
  ];
  const SYNC_DEVICES = [
    { deviceId: 'dev_mbp', deviceName: 'Jonathon’s MacBook Pro', syncedAt: iso(10 * MIN) },
    { deviceId: 'dev_mini', deviceName: 'Office Mac mini', syncedAt: iso(12 * MIN) },
  ];

  // ── Token usage ─────────────────────────────────────────────────────────
  const TOKEN_ROWS = {
    model: [['Claude Sonnet 5.5', 48200000, 212400000], ['Claude Haiku 5.5', 21300000, 18600000], ['Claude Opus 5.5', 6100000, 61000000], ['Qwen3 32B (local)', 9800000, 0]],
    provider: [['anthropic', 75600000, 292000000], ['ollama', 9800000, 0]],
    agent: [['Estimator', 31800000, 141000000], ['Storm responder', 18400000, 61300000], ['Lead intake', 14900000, 38200000], ['Sulla', 12600000, 46400000], ['Supplier price watch', 7700000, 5100000]],
    device: [[SERVER ? 'Sulla Server' : 'Sulla Cloud', 52300000, 214000000], ['Office Mac mini', 21400000, 47200000], ['Jonathon’s MacBook Pro', 11700000, 30800000]],
  };
  function tokens(params) {
    const group = params.get('group') || 'model';
    const rows = (TOKEN_ROWS[group] || TOKEN_ROWS.model).map(([key, t, cost]) => ({ key, source: 'byo', tokens: t, costMicros: cost }));
    const days = 30;
    const daily = Array.from({ length: days }, (_, i) => { const wave = 0.65 + 0.35 * Math.sin(i / 3) + (i % 7 === 5 || i % 7 === 6 ? -0.35 : 0) + (i === 23 ? 0.9 : 0); return { date: day(days - 1 - i), byo_tokens: Math.round(2850000 * Math.max(0.2, wave)), paid_tokens: SERVER ? 0 : Math.round(900000 * Math.max(0.2, wave)) }; });
    const total = rows.reduce((n, r) => n + r.tokens, 0);
    const cost = rows.reduce((n, r) => n + r.costMicros, 0);
    if (SERVER) return { summary: { total, byo: { tokens: total, costMicros: cost, providers: ['anthropic', 'ollama'] }, paid: { tokens: 0, costMicros: 0 }, cap: { used: TOKEN_CAPS.month.used, limit: TOKEN_CAPS.month.limit } }, rows, daily };
    const paid = [{ key: '@cf/zai-org/glm-4.7-flash', source: 'paid', tokens: 24100000, costMicros: 8400000 }];
    return { summary: { total: total + 24100000, byo: { tokens: total, providers: ['anthropic', 'ollama'] }, paid: { tokens: 24100000, costMicros: 8400000 } }, rows: [...paid, ...rows], daily };
  }
  // Server: monthly token caps per organization (stand-in for Cloud's fair-use meters).
  const TOKEN_CAPS = { month: { used: 85400000, limit: 150000000, resets: ahead(7 * DAY) }, topMember: { name: 'Jonathon Byrdziak', used: 12100000, limit: 20000000 }, topAgent: { name: 'Estimator', used: 31800000, limit: 40000000 } };
  let usageSettings = SERVER ? { warnAt80: true, atLimit: 'pause', orgCapM: 150, memberCapM: 20, agentCapM: 40 } : { warnAt80: true, atLimit: 'ask', overageCapCents: 5000 };

  // ── Server administration (Sulla Server only) ───────────────────────────
  const SERVER_ADMIN = {
    host: HOST, vaultHost: `vault.${HOST}`, version: '1.9.2', installedAt: '2026-10-20T10:00:00Z', serverId: 'srv_9d2b41c7', edition: 'Community',
    seats: { used: 18, total: 25 }, storage: { usedGb: 41.2, totalGb: 500 },
    services: [['Console', 'sulla-console', '6d'], ['Accounts', 'sulla-accounts', '6d'], ['Vault', 'sulla-vault', '6d'], ['Files', 'sulla-files', '6d'], ['Agents', 'sulla-agents', '2d'], ['Workflows', 'sulla-workflows', '6d'], ['Tools', 'sulla-tools', '6d'], ['Gateway', 'sulla-gateway', '6d'], ['Relay', 'sulla-relay', '6d'], ['Redis', 'sulla-redis', '6d'], ['Postgres', 'sulla-postgres', '6d']].map(([name, container, up]) => ({ name, container, up, state: 'running' })),
    machine: { name: 'Office Mac mini', chip: 'Apple M4', memoryGb: 32, cpuPct: 18, memUsedGb: 19.4, diskUsedGb: 41.2, diskTotalGb: 500 },
    license: { key: 'SULLA-CMTY-7F3K-X8PD-R4TW-Q2M9', masked: 'SULLA-CMTY-7F3K-••••-••••-Q2M9', registeredTo: 'jonathon@northwind.co', nextCheckIn: ahead(13 * HOUR) },
    users: [...MEMBERS.map((m) => ({ ...m, org: 'Northwind Roofing' })), ...GUTTER_MEMBERS.filter((m) => m.userId !== 'usr_jb').map((m) => ({ ...m, org: 'Northwind Gutters & Siding' })), { userId: 'usr_dw', name: 'Dana Wells', email: 'dana@northwind.co', role: 'invited', org: 'Northwind Roofing' }],
    providers: [['Anthropic', 'Claude Opus 5.5, Sonnet 5.5, Haiku 5.5', true, 'sk-ant-…7Qa2'], ['OpenAI', 'Embeddings for file search', true, 'sk-…m81X'], ['Local models', 'Ollama on Office Mac mini · qwen3:32b', true, 'http://10.0.1.20:11434'], ['Google', 'Not connected', false, '']],
    desktops: [['dev_mbp', 'Jonathon’s MacBook Pro', 'Jonathon Byrdziak', 'Workflows, agents, chats, files', iso(MIN)], ['dev_mini', 'Office Mac mini', 'Northwind Roofing', 'Workflows, agents, recipes', iso(MIN)], ['dev_air', 'Sam’s MacBook Air', 'Sam Ortiz', 'Workflows', iso(19 * HOUR)], ['dev_pc', 'Estimating PC', 'Ray King', 'Workflows', iso(41 * DAY)]],
    pendingDesktops: [['dev_new', 'Kara’s MacBook Air', 'Kara Singh', iso(25 * MIN)]],
    backups: { last: earlyToday(120), sizeGb: 40.9, keep: 14, destination: 'S3 · northwind-sulla-backups' },
    updates: [['1.9.2', '2026-10-20', 'Vault sharing fixes'], ['1.9.0', '2026-10-13', 'Workflow runners in containers'], ['1.8.4', '2026-10-06', 'Faster file search']],
    audit: [
      [9 * MIN, 'Estimator', 'agent', 'Used vault item “ABC Supply portal” (autofill)', 'Sulla Server'],
      [32 * MIN, 'Sam Ortiz', 'admin', 'Invited dana@northwind.co to Northwind Roofing', '73.42.18.6'],
      [58 * MIN, 'Jonathon Byrdziak', 'signin', 'Signed in with email and password', '10.0.1.24'],
      [2 * HOUR, 'Kara Singh', 'admin', 'Asked to link Desktop “Kara’s MacBook Air”', '10.0.1.37'],
      [5 * HOUR, 'Storm responder', 'vault', 'Used vault item “Twilio” (autofill)', 'Sulla Server'],
      [20 * HOUR, 'Jonathon Byrdziak', 'admin', 'Changed the Anthropic API key', '10.0.1.24'],
      [22 * HOUR, 'System', 'admin', 'Nightly backup succeeded · 40.9 GB', 'Sulla Server'],
      [2 * DAY, 'Jonathon Byrdziak', 'agents', 'Let Estimator autofill “ABC Supply portal”', '10.0.1.24'],
      [2 * DAY, 'Ray King', 'signin', 'Failed sign-in · wrong password', '71.212.4.90'],
      [3 * DAY, 'Jonathon Byrdziak', 'admin', 'Approved Desktop “Office Mac mini”', '10.0.1.24'],
    ].map(([ago, who, kind, what, from]) => ({ at: iso(ago), who, kind, what, from })),
  };

  // ── Vault (Passwords on its own address) ────────────────────────────────
  const VAULT_STATUS = () => ({ enabled: true, vaultId: window.SullaVaultFixture?.bundle?.vaultId || '0d5e0000-0000-4000-8000-0000000000d1', headSeq: window.SullaVaultFixture?.head?.seq || 1, syncPaused: false, bundleGeneration: 1, epoch: 1, itemCount: 14, sourceDeviceId: SERVER ? null : 'dev_mbp', sourceDeviceName: SERVER ? 'Sulla Server' : 'Jonathon’s MacBook Pro', sourceDeviceLastSeenAt: iso(MIN).replace('T', ' ').replace(/\.\d+Z$/, ''), syncSettings: { vault: true } });
  const VAULT_AUDIT = [
    [9 * MIN, 'autofill', 'ABC Supply portal', 'Estimator', 'Sulla Server'], [5 * HOUR, 'autofill', 'Twilio', 'Storm responder', 'Sulla Server'], [20 * HOUR, 'edit', 'Anthropic API key', 'Jonathon Byrdziak', 'Chrome on macOS'], [2 * DAY, 'policy', 'ABC Supply portal', 'Jonathon Byrdziak', 'Chrome on macOS'], [3 * DAY, 'reveal', 'QuickBooks Online', 'Maria Chen', 'Sulla Desktop'], [4 * DAY, 'create', 'State Farm agent portal', 'Aisha Hassan', 'Chrome on Windows'],
  ].map(([ago, action, item, actor, client], i) => ({ id: `a_${i}`, at: iso(ago), createdAt: iso(ago), action, event: action, itemName: item, actorName: actor, actor, client, clientLabel: client, device: client }));

  // ── Server administration routes ────────────────────────────────────────
  const A = SERVER_ADMIN;
  const seats = () => ({ used: A.seats.used, total: A.seats.total });

  function license() {
    const valid = licenseValid();
    return {
      valid,
      reason: valid ? null : 'lapsed',
      edition: A.edition,
      masked: A.license.masked,
      seats: seats(),
      registeredTo: A.license.registeredTo,
      serverId: A.serverId,
      nextCheckIn: A.license.nextCheckIn,
      catalogAllowed: valid,
    };
  }

  const SECTIONS = {
    '/server/v1/overview': () => ({
      host: A.host,
      edition: A.edition,
      version: A.version,
      seats: seats(),
      storage: A.storage,
      services: A.services,
      machine: A.machine,
    }),
    '/server/v1/users': () => ({
      edition: A.edition,
      seats: seats(),
      users: A.users.map((u) => ({
        id: u.userId,
        name: u.name,
        email: u.email,
        org: u.org,
        role: u.role === 'invited' ? 'member' : u.role,
        status: u.role === 'invited' ? 'invited' : 'active',
        joinedAt: u.joinedAt || null,
        isServerAdmin: u.userId === ME.id,
        isYou: u.userId === ME.id,
        invitationId: u.role === 'invited' ? 'inv_dw' : undefined,
        orgId: u.role === 'invited' ? 'org_northwind' : undefined,
      })),
    }),
    '/server/v1/license': license,
    '/server/v1/domains': () => ({
      host: A.host,
      vaultHost: A.vaultHost,
      relayUrl: `wss://${A.host}/relay`,
      relayConnected: true,
      certificate: { expiresAt: ahead(71 * DAY + HOUR) },
      letsEncrypt: true,
      network: { lan: true, public: true, allowedRanges: [] },
    }),
    '/server/v1/signin': () => ({
      methods: { password: true, emailCode: true, sso: false },
      requireTwoStep: false,
      invitationDays: 7,
      smtp: { host: 'smtp.northwind.co', port: 587, from: 'sulla@northwind.co' },
    }),
    '/server/v1/providers': () => ({
      providers: A.providers.map(([name, description, connected, hint]) => {
        const id = { Anthropic: 'anthropic', OpenAI: 'openai', 'Local models': 'ollama', Google: 'google' }[name];
        const local = id === 'ollama';
        return { id, name, description, connected, kind: local ? 'local' : 'api', [local ? 'baseUrl' : 'keyHint']: hint };
      }),
      models: [
        { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
        { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
        { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
        { id: 'qwen3:32b', label: 'Qwen3 32B (local)' },
      ],
      defaults: { model: 'claude-sonnet-5-5', fallback: 'qwen3:32b' },
    }),
    '/server/v1/desktops': () => ({
      pending: A.pendingDesktops.map(([id, name, user, requestedAt]) => ({ id, name, user, requestedAt })),
      desktops: A.desktops.map(([id, name, user, syncs, lastSeenAt]) => ({ id, name, user, syncs, lastSeenAt })),
      rules: { requireApproval: true, runWorkflows: true },
    }),
    '/server/v1/storage': () => ({
      dataDir: '/srv/sulla/data',
      diskTotalGb: A.storage.totalGb,
      volumes: [
        { name: 'Files', sizeGb: 38.7, unit: 'stored', detail: 'Organization files', source: 'sulla-files' },
        { name: 'Database', sizeGb: 2.1, unit: 'Postgres', detail: 'Accounts, chats, workflows', source: 'sulla-postgres' },
        { name: 'Recipe volumes', sizeGb: 0.4, unit: '2 volumes', detail: 'Use case containers', source: 'Docker' },
      ],
    }),
    '/server/v1/backups': () => ({
      nightly: true,
      time: '2:00 AM',
      keep: A.backups.keep,
      destination: A.backups.destination,
      last: { at: A.backups.last, sizeGb: A.backups.sizeGb, status: 'succeeded' },
    }),
    '/server/v1/updates': () => ({
      version: A.version,
      installedAt: A.installedAt,
      latest: { version: A.version },
      history: A.updates.map(([version, at, notes]) => ({ version, installedAt: `${at}T12:00:00Z`, notes })),
    }),
    '/server/v1/audit': (params) => {
      const kind = params.get('kind');
      const match = (e) => !kind || e.kind === kind || (kind === 'agents' && e.kind === 'agent');
      return { events: A.audit.filter(match), nextBefore: null };
    },
  };

  function serverAdminRoute(method, p, params, body) {
    if (method === 'GET' && SECTIONS[p]) return ok(D(SECTIONS[p](params)));
    if (method === 'GET' && /^\/server\/v1\/services\/[^/]+\/logs$/.test(p)) {
      const name = decodeURIComponent(p.split('/')[4]);
      const lines = [0, 1, 2].map((i) => `${iso((3 - i) * MIN)} ${name} | synthetic log line ${i + 1}`);
      return ok(D({ lines }));
    }
    if (method === 'POST' && p === '/server/v1/license') {
      try {
        localStorage.removeItem(LICENSE_KEY);
      } catch (_) {
        // nothing to clear
      }
      return body?.key ? ok(D(license())) : { status: 400, body: { error: 'A license key is required.' } };
    }
    if (p.startsWith('/server/v1/') && method !== 'GET') return ok(D({ ok: true }));
    return null;
  }

  // ── Router ──────────────────────────────────────────────────────────────
  function currentOrg() { return ORGS.find((o) => o.id === activeOrgId) || ORGS[0]; }
  const D = (data) => ({ data });
  const ok = (body) => ({ status: 200, body });
  const notFound = () => ({ status: 404, body: { error: 'not_found' } });

  function route(method, path, params, body) {
    const p = path;
    // Auth and organizations
    if (p === '/auth/me') return ok({ contractor: profile() });
    if (p === '/teams' && method === 'GET') return ok({ teams: ORGS.map((o) => ({ id: o.id, name: o.name, role: o.role, memberCount: membersOf(o.id).length, color: o.color })) });
    if (p === '/auth/switch-team') { activeOrgId = body?.teamId || activeOrgId; try { localStorage.setItem('sulla_team_id', activeOrgId); } catch (_) {} return ok({ contractor: profile() }); }
    if (p === '/auth/logout') {
      setCsrf('', 0);
      return { status: 204, body: null };
    }
    if (p === '/auth/sessions' && method === 'GET') return ok({ sessions: [
      { id: 's1', current: true, userAgent: navigator.userAgent, city: 'Boise, ID', lastActiveAt: iso(0) },
      { id: 's2', app: 'Sulla Desktop', deviceName: 'Office Mac mini', city: 'Boise, ID', lastActiveAt: iso(MIN) },
      { id: 's3', app: 'Sulla Desktop', deviceName: 'Jonathon’s MacBook Pro', city: 'Boise, ID', lastActiveAt: iso(MIN) },
      { id: 's4', app: 'Sulla Mobile', deviceName: 'Sulla Mobile (iPhone)', userAgent: 'Sulla Mobile iPhone', city: 'Meridian, ID', lastActiveAt: iso(3 * MIN) },
    ] });
    if (p === '/notifications/preferences') return ok({
      targets: { iosDevices: 1, webPush: 0, email: ME.email, thisBrowser: false }, channelsAvailable: ['push', 'email', 'inapp'], textSound: true,
      categories: [
        { key: 'agent', label: 'Agents waiting on me', description: 'An agent needs a reply or an approval.', channels: { push: true, email: true, inapp: true } },
        { key: 'workflow', label: 'Workflow failures', description: 'A workflow run failed or a device it needs went offline.', channels: { push: true, email: true, inapp: true } },
        { key: 'files', label: 'Shared with me', description: 'Someone shares a file or document with you.', channels: { push: false, email: true, inapp: true } },
        { key: 'security', label: 'Security', description: 'New sign-ins and vault access changes.', locked: true, channels: { push: true, email: true, inapp: true } },
        { key: 'marketing', label: 'Product news', description: 'New Sulla features.', channels: { push: false, email: false, inapp: false } },
      ],
      quietHours: { enabled: true, start: '21:00', end: '06:30', timezone: ME.timezone, allowCalls: true },
      workspaces: ORGS.map((o) => ({ teamId: o.id, name: o.name, muted: false })),
    });
    if (p === '/devices') return ok({ devices: DEVICES });
    if (p.startsWith('/teams/')) {
      const [, , teamId, sub, subId] = p.split('/');
      const org = ORGS.find((o) => o.id === teamId) || currentOrg();
      if (!sub) return ok({ team: { id: org.id, name: org.name, createdAt: org.createdAt } });
      if (sub === 'members') return ok({ members: membersOf(org.id) });
      if (sub === 'invitations') return method === 'POST' ? ok({ emailSent: true }) : ok({ invitations: org.id === 'org_northwind' ? INVITES : [] });
      return ok({ ok: true, subId });
    }
    if (p === '/invite/mine') return ok({ invitations: [] });

    // Dashboard summaries
    if (p === '/cloud-dashboard/v1/summary') return ok(D({ counts: { passwords: 14 } }));
    if (p === '/cloud-dashboard/v1/devices') return ok(D({ devices: DEVICES }));
    if (p === '/cloud-dashboard/v1/organizations') return ok(D({ organizations: ORGS.map((o) => ({ ...o, memberCount: membersOf(o.id).length, deviceCount: o.id === 'org_northwind' ? DEVICES.length : 2, agentCount: o.id === 'org_northwind' ? AGENTS.length : 1 })) }));
    if (/^\/cloud-dashboard\/v1\/organizations\/[^/]+\/memberships$/.test(p)) return ok(D({ memberships: membersOf(p.split('/')[4]) }));

    // Runtime
    if (p === '/cloud-runtime/v1/agents') return ok(D({ agents: AGENTS }));
    if (p === '/cloud-runtime/v1/workflows') return ok(D({ workflows: WORKFLOWS }));
    if (p.startsWith('/cloud-runtime/v1/workflow-runs/')) return ok(D({ run: RUN_DETAIL(decodeURIComponent(p.split('/').pop())) }));
    if (p === '/cloud-runtime/v1/model-catalog') return ok(D({ catalog: [
      { source: 'metered', providerId: 'anthropic', providerName: 'Anthropic', models: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }, { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }, { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }] },
      { source: 'desktop', providerId: 'ollama', providerName: 'Ollama', deviceId: 'dev_mbp', deviceName: 'Jonathon’s MacBook Pro', models: [{ id: 'qwen3:32b', name: 'Qwen3 32B' }] },
      { source: 'agent', id: 'estimator', name: 'Estimator' }, { source: 'agent', id: 'lead-intake', name: 'Lead intake' },
    ] }));
    if (p === '/cloud-runtime/v1/skills') return ok(D({ skills: SKILLS }));
    if (p === '/cloud-runtime/v1/custom-agents') return ok(D({ agents: CUSTOM_AGENTS }));
    if (p === '/cloud-runtime/v1/recipes') return ok(D({ recipes: RECIPES }));
    if (p === '/cloud-runtime/v1/sync-status') return ok(D({ devices: SYNC_DEVICES }));
    if (p === '/cloud-runtime/v1/usage') return ok(D({ usage: {} }));
    if (p.startsWith('/routines/')) return ok({ execution_id: WORKFLOWS[0].runs[0].executionId });

    // Chat
    if (p === '/chat/conversations' && method === 'GET') return ok({ conversations: CHATS });
    if (p === '/chat/conversations' && method === 'POST') { const c = { id: `chat_${Date.now()}`, title: 'New Conversation', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }; CHATS.unshift(c); MESSAGES[c.id] = []; return ok({ conversation: c }); }
    let m = /^\/chat\/conversations\/([^/]+)\/messages$/.exec(p);
    if (m && method === 'GET') return ok({ messages: (MESSAGES[m[1]] || []).map(([role, content, ago], i) => ({ id: `${m[1]}_${i}`, role, content, created_at: iso(ago * MIN) })) });
    if (m && method === 'POST') { (MESSAGES[m[1]] = MESSAGES[m[1]] || []).push(['user', body?.content || '', 0]); return ok({ ok: true }); }
    m = /^\/chat\/conversations\/([^/]+)\/run$/.exec(p);
    if (m) { (MESSAGES[m[1]] = MESSAGES[m[1]] || []).push(['assistant', 'On it. I’ll post an update here when it’s done.', 0]); return ok({ ok: true }); }
    m = /^\/chat\/conversations\/([^/]+)\/heartbeat$/.exec(p);
    if (m) return ok(D({ enabled: m[1] === 'chat_hartley', intervalMinutes: 30, message: 'Heartbeat: give me a short update on what moved since your last update, then keep working on anything unfinished.', nextAt: ahead(18 * MIN) }));
    if (/^\/chat\/conversations\/[^/]+$/.test(p)) return ok({ ok: true });
    if (p === '/cloud-chat-links') return ok({ conversations: LINKED });
    m = /^\/cloud-chat-links\/([^/]+)\/messages$/.exec(p);
    if (m) return ok({ data: { messages: [], nextCursor: 0 } });

    // Files
    if (p === '/cloud-files/v1/files') {
      const q = (params.get('q') || '').toLowerCase();
      const recent = params.get('recent');
      const dev = params.get('deviceId');
      const parent = params.get('parentPath') || '';
      let items = recent ? FILES.filter((f) => f.kind !== 'folder') : FILES.filter((f) => (f.parentPath || '') === parent);
      if (dev) items = items.filter((f) => f.cameFrom?.deviceId === dev);
      if (q) items = FILES.filter((f) => f.name.toLowerCase().includes(q));
      return ok(D({ items: items.map((f) => ({ ...f })) }));
    }
    m = /^\/cloud-files\/v1\/files\/([^/]+)$/.exec(p);
    if (m) { const f = fileById(decodeURIComponent(m[1])); return f ? ok(D({ file: fileDetail(f) })) : notFound(); }
    if (/^\/cloud-files\/v1\/files\/[^/]+\/content-request$/.test(p)) return ok(D({ requestId: 'cr_1' }));
    if (p === '/cloud-files/v1/shared') return ok(D({
      sharedByMe: [
        { kind: 'link', id: 'l_1', name: 'Q4 price sheet.csv', url: '/s/7Hq2xLk', access: 'View', availability: 'kept-in-cloud', views: 12, cameFrom: fromDev('dev_mini') },
        { kind: 'grant', id: 'g_1', name: 'Crew safety handbook 2026', url: null, access: `${currentOrg().name} members`, availability: 'cloud-native', views: null, cameFrom: fromServer },
        { kind: 'grant', id: 'g_2', name: 'Hartley · claim packet', url: null, access: 'Aisha Hassan', availability: 'cloud-native', views: null, cameFrom: fromServer },
      ],
      sharedWithMe: [
        { name: 'Storm season playbook', sharedByName: 'Sam Ortiz', orgName: currentOrg().name, itemType: 'document', targetId: 'doc_storm', orgId: currentOrg().id, createdAt: iso(3 * DAY), cameFrom: fromServer },
        { name: 'Gutter guard spec sheet.pdf', sharedByName: 'Owen Park', orgName: 'Northwind Gutters & Siding', itemType: 'file', createdAt: iso(5 * DAY), cameFrom: fromServer },
      ],
    }));
    if (p === '/cloud-files/v1/trash') return ok(D({ items: [F('Old price sheet (August).csv', '', { mime: 'text/csv', size: 172000, ago: 6 * DAY, owner: 'Maria Chen', id: 'trash_1' })] }));
    m = /^\/cloud-files\/v1\/documents\/([^/]+)$/.exec(p);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const f = fileById(id) || { name: 'Untitled document', modifiedAt: iso(0) };
      const doc = DOCS[id] || { title: f.name, content: `# ${f.name}\n` };
      const document = { id, title: doc.title, content: doc.content, version: 4, updatedAt: f.modifiedAt, updatedByName: 'Jonathon Byrdziak', path: f.path };
      if (method === 'PUT') return ok(D({ document: { ...document, ...(body || {}), version: 5 } }));
      return ok(D({ document, versions: [{ version: 4, editedByName: 'Jonathon Byrdziak', createdAt: f.modifiedAt }, { version: 3, editedBySource: 'agent', editedByName: 'Sulla', createdAt: iso(2 * DAY) }, { version: 2, editedByName: 'Sam Ortiz', createdAt: iso(4 * DAY) }, { version: 1, editedByName: 'Jonathon Byrdziak', createdAt: iso(9 * DAY) }] }));
    }
    if (p === '/cloud-files/v1/documents' && method === 'POST') return ok(D({ document: { id: 'doc_safety' } }));

    // Vault
    if (p === '/cloud-vault-sync/status') return ok(VAULT_STATUS());
    if (p === '/cloud-vault-sync/browser/handoff') return ok({ code: 'mock-handoff' });

    // Use Cases
    if (p === '/marketplace/browse') {
      const q = (params.get('q') || '').toLowerCase();
      const topic = params.get('topic');
      let items = TEMPLATES.filter((t) => (!topic || t.topic === topic) && (!q || `${t.title} ${t.line}`.toLowerCase().includes(q)));
      if (params.get('sort') === 'popular') items = [...items].sort((a, b) => b.download_count - a.download_count);
      return ok({ templates: items });
    }
    if (p === '/marketplace/kinds') return ok({ kinds: KINDS });
    if (p === '/marketplace/topics') return ok({ topics: TOPICS });
    m = /^\/marketplace\/templates\/([^/]+)(\/install)?$/.exec(p);
    if (m) { const t = TEMPLATES.find((x) => x.id === decodeURIComponent(m[1])) || TEMPLATES[0]; return m[2] ? ok({ ok: true }) : ok({ template: t }); }
    m = /^\/cloud-usecase-installs\/v1\/templates\/([^/]+)\/(review|installs|device-installs)$/.exec(p);
    if (m) {
      const t = TEMPLATES.find((x) => x.id === decodeURIComponent(m[1])) || TEMPLATES[0];
      const lib = LIBRARY.find((x) => x.templateId === t.id);
      if (m[2] === 'review') return ok(D(review(t, (params.get('targets') || 'cloud').split(','))));
      if (m[2] === 'installs') return ok(D({ cloud: { installed: !!lib?.cloud }, devices: lib?.devices || [] }));
      return ok(D({ install: { status: 'queued' } }));
    }
    if (p === '/cloud-usecase-installs/v1/library') return ok(D({ library: LIBRARY }));

    // Organization settings: usage
    if (p === '/usage/tokens') return ok(D(tokens(params)));
    if (p === '/usage/settings') { if (method === 'PUT' && body) usageSettings = { ...usageSettings, ...body }; return ok(D(usageSettings)); }
    if (p === '/usage/summary') return ok(D({ tiles: {}, daily: { dates: Array.from({ length: 14 }, (_, i) => day(13 - i)), agentHours: [6, 7, 5, 8, 9, 3, 2, 8, 9, 11, 7, 8, 4, 3] }, byMachine: [{ name: SERVER ? 'Sulla Server' : 'Sulla Cloud', hours: 61, pct: 58 }, { name: 'Office Mac mini', hours: 29, pct: 28 }, { name: 'Jonathon’s MacBook Pro', hours: 15, pct: 14 }], byAgent: [{ name: 'Estimator', hours: 38 }, { name: 'Storm responder', hours: 22 }, { name: 'Lead intake', hours: 19 }], biggestJobs: [{ job: 'Lakeside HOA bid', agent: 'Estimator', hours: 4.2 }, { job: 'Hail outreach · Oct 23', agent: 'Storm responder', hours: 3.1 }] }));
    if (p === '/usage/token-caps') return ok(D(TOKEN_CAPS));
    // Server administration: one route per section (BUILD-PLAN.md section 1).
    const admin = serverAdminRoute(method, p, params, body);
    if (admin) return admin;

    if (method !== 'GET') return ok({ ok: true });
    return notFound();
  }

  // ?vault=enroll on the vault page: a member who hasn't set up their vault yet. Enrollment serves
  // the fixture account's unsigned bundle fields; the browser MACs them and PUTs the bundle back.
  const ENROLL = new URLSearchParams(location.search).get('vault') === 'enroll';
  const enrolled = { bundle: null, head: null };
  window.SullaMock.enrolled = enrolled;

  function enrollRoute(method, path, body) {
    const fx = window.SullaVaultFixture;
    const vaultPath = `/cloud-vault-sync/vaults/${fx.bundle.vaultId}`;
    if (path === '/cloud-vault-sync/status' && !enrolled.bundle) {
      return ok({ enabled: false, orgId: currentOrg().id, vaultId: fx.bundle.vaultId, setup: 'enroll', collections: 0 });
    }
    if (path === `${vaultPath}/enrollment`) {
      const { format: _f, v: _v, mac: _m, ...fields } = fx.bundle;
      return ok({ op: 'create', fields, expectedBundleGeneration: 0 });
    }
    if (method === 'PUT' && path === vaultPath && body?.scope === 'personal') {
      Object.assign(enrolled, { bundle: body.bundle, head: body.head });
      return { status: 201, body: { ok: true, vaultId: fx.bundle.vaultId, headSeq: body.head.seq } };
    }
    if (enrolled.bundle && path === `${vaultPath}/bundle`) return ok(enrolled.bundle);
    if (enrolled.bundle && path === `${vaultPath}/records`) return ok({ head: enrolled.head, records: [], nextCursor: null });
    return null;
  }

  // Vault origin endpoints, answered same-origin (vault.html only).
  function vaultRoute(method, path, params, body) {
    const early = ENROLL ? enrollRoute(method, path, body) : null;
    if (early) return early;
    const fx = window.SullaVaultFixture;
    const org = currentOrg();
    if (path === '/cloud-vault-sync/browser/session') return ok({ ok: true, org: { id: org.id, name: org.name, role: org.role }, user: { name: ME.name, email: ME.email }, session: { id: 'vs_1', expiresAt: ahead(HOUR) } });
    if (path === '/cloud-vault-sync/status') return ok(VAULT_STATUS());
    if (path === '/cloud-vault-sync/browser/devices') return SERVER ? ok({ devices: DEVICES }) : notFound();
    if (/\/bundle$/.test(path)) return ok(fx.bundle);
    if (/\/records$/.test(path)) return ok({ head: fx.head, records: fx.records, nextCursor: null, syncPaused: false, bundleGeneration: 1, epoch: 1 });
    if (/\/commit$/.test(path)) return ok({ ok: true });
    if (path === '/cloud-vault-sync/audit') return ok({ events: VAULT_AUDIT, entries: VAULT_AUDIT, items: VAULT_AUDIT, nextBefore: null });
    if (path.startsWith('/files-sync/v1/collections')) return ok({ collections: [], versions: [], items: [] });
    if (method !== 'GET') return ok({ ok: true });
    return notFound();
  }

  // ── fetch interception ──────────────────────────────────────────────────
  const realFetch = window.fetch.bind(window);
  const json = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async function mockFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const method = String(init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch (_) { body = null; }
    const href = url.href;
    if (href.startsWith(BASE)) {
      const path = href.slice(BASE.length).split('?')[0].split('#')[0];
      if (/^\/cloud-files\/v1\/content-requests\//.test(path)) {
        return new Response(new Blob(['Synthetic file from the Sulla Server mockup.\n'], { type: 'text/plain' }), { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }
      window.SullaMock.calls.push(`${method} ${path}${url.search}`);
      const res = route(method, path, url.searchParams, body);
      await new Promise((r) => setTimeout(r, 40));
      return json(res.status, res.body);
    }
    if (url.origin === location.origin && (url.pathname.startsWith('/cloud-vault-sync') || url.pathname.startsWith('/files-sync'))) {
      const res = vaultRoute(method, url.pathname, url.searchParams, body);
      await new Promise((r) => setTimeout(r, 40));
      return json(res.status, res.body);
    }
    return realFetch(input, init);
  };

})();
