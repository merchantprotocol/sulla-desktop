// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

// Sulla Server: extra destinations for the ⌘K palette (the shell adds window.SullaServerPages).
(function () {
  'use strict';

  const admin = [
    ['overview', 'Overview', 'server'],
    ['users', 'Users & seats', 'users'],
    ['license', 'License', 'key'],
    ['domains', 'Domains & access', 'globe'],
    ['signin', 'Sign-in methods', 'lock'],
    ['providers', 'Model providers', 'agent'],
    ['desktops', 'Linked Desktops', 'laptop'],
    ['storage', 'Storage & backups', 'folderLine'],
    ['updates', 'Updates', 'clock'],
    ['audit', 'Audit log', 'list'],
  ].map(([id, label, icon]) => ({
    id: `srv-${id}`,
    label,
    icon,
    href: `server-admin.html#st=${id}`,
    group: 'Server administration',
  }));

  const more = [
    ['uc-library', 'My Library', 'grid', 'use-cases.html#uc=library'],
    ['uc-updates', 'Use case updates', 'grid', 'use-cases.html#uc=updates'],
    ['skills', 'Saved Skills', 'bolt', 'skills.html'],
    ['custom-agents', 'Custom Agents', 'agent', 'custom-agents.html'],
    ['recipes', 'Recipes', 'grid', 'recipes.html'],
    ['tokens', 'Token usage', 'list', 'organization-settings.html#st=tokens'],
    ['limits', 'Usage & limits', 'list', 'organization-settings.html#st=usage'],
    ['members', 'Members & invites', 'users', 'organization-settings.html#st=members'],
    ['account', 'Account settings', 'user', 'account.html#st=profile'],
    ['shared', 'Shared files', 'share', 'files.html#sec=shared'],
  ].map(([id, label, icon, href]) => ({ id: `page-${id}`, label, icon, href, group: 'More pages' }));

  window.SullaServerPages = [...admin, ...more];
})();
