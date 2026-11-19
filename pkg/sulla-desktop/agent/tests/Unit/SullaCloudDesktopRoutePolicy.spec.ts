// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { SullaCloudDesktopRoutePolicy } from '../../../../../services/sulla-vault/src/localAuthority/SullaCloudDesktopRoutePolicy';

const root = process.cwd();
const mainRoot = path.join(root, 'pkg/sulla-desktop/main');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(fullPath) : /\.tsx?$/.test(entry.name) ? [fullPath] : [];
  });
}

function isRequestCall(node: ts.CallExpression): boolean {
  return (ts.isIdentifier(node.expression) && node.expression.text === 'cloudRequest') ||
    (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'cloudRequest');
}

function stringLiteral(node: ts.Expression | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

// Calls routed through a typed adapter have dynamic arguments by design. Keep this
// inventory explicit: any new dynamic cloudRequest callsite must be reviewed and
// added here instead of silently escaping the policy contract scan.
const reviewedDynamicCallSites = [
  'cloud/conversationSync/service.ts:101',
  'cloud/conversationSync/service.ts:116',
  'cloud/conversationSync/service.ts:127',
  'cloud/conversationSync/service.ts:149',
  'cloud/conversationSync/service.ts:220',
  'cloud/conversationSync/service.ts:246',
  'cloud/cloudDataSync.ts:31',
  'cloud/cloudDataSync.ts:32',
  'cloud/cloudDataSync.ts:40',
  'cloud/desktopObjectSync.ts:109',
  'cloud/desktopObjectSync.ts:133',
  'cloud/devices/devicesPanelIpc.ts:22',
  'cloud/enrollment/DesktopVaultEnrollmentModule.ts:59',
  'cloud/memorySyncV1/index.ts:44',
  'cloud/slack/SlackCloudClient.ts:30',
  'cloud/slack/SlackCloudClient.ts:64',
  'devicesCloudApi.ts:118',
  'devicesCloudApi.ts:185',
  'ipc/MainIpcControllersProvider.ts:94',
  'marketplace/client.ts:167',
  'marketplace/client.ts:175',
  'marketplace/client.ts:251',
  'marketplace/cloudInstall/deviceInstallSync.ts:54',
  'marketplace/cloudInstall/deviceInstallSync.ts:72',
  'supportSessionIpc.ts:20',
  'sync/SullaSyncService.ts:229',
];

describe('Sulla Cloud desktop route policy', () => {
  it('allows only the supporter session read and action routes used by the session tab', () => {
    // risk: permissions — preserve the super-admin checked endpoints while denying unrelated session writes.
    const allowed: Array<[string, string]> = [
      ['GET', '/super-admin/support/sessions'],
      ['GET', '/super-admin/support/sessions/session_123/presence'],
      ['POST', '/super-admin/support/sessions/session_123/end'],
      ['POST', '/super-admin/support/sessions/session_123/extend'],
    ];
    for (const [method, route] of allowed) expect(SullaCloudDesktopRoutePolicy.allowsSullaCloudDesktopRequest(method, route), `${method} ${route}`).toBe(true);
    expect(SullaCloudDesktopRoutePolicy.allowsSullaCloudDesktopRequest('DELETE', '/super-admin/support/sessions/session_123/end')).toBe(false);
  });

  it('allows only the methods Desktop uses for device, memory-sync, and Slack routes', () => {
    const allowed: Array<[string, string]> = [
      ['GET', '/devices'], ['GET', '/devices/device-01'], ['PATCH', '/devices/device-01'], ['DELETE', '/devices/device-01'],
      ['GET', '/memory-sync/v1/key-slot'], ['PUT', '/memory-sync/v1/key-slot'],
      ['GET', '/memory-sync/v1/changes'], ['POST', '/memory-sync/v1/commit'], ['DELETE', '/memory-sync/v1/cloud-copy'],
      ['GET', '/slack/inbound'], ['POST', '/slack/inbound/ack'],
      ['POST', '/slack/workspaces'], ['DELETE', '/slack/workspaces'],
    ];
    for (const [method, route] of allowed) {
      expect(SullaCloudDesktopRoutePolicy.allowsSullaCloudDesktopRequest(method, route), `${method} ${route}`).toBe(true);
    }
  });

  it('rejects wrong methods, malformed device ids, and adjacent unsupported routes', () => {
    const denied: Array<[string, string]> = [
      ['POST', '/devices'], ['PUT', '/devices/device-01'], ['GET', '/devices/device-01/events'],
      ['GET', '/devices/bad%2Fid'], ['PATCH', '/memory-sync/v1/commit'],
      ['PUT', '/memory-sync/v1/changes'], ['GET', '/memory-sync/v1/cloud-copy'],
      ['PUT', '/slack/inbound/ack'], ['GET', '/slack/workspaces'],
    ];
    for (const [method, route] of denied) {
      expect(SullaCloudDesktopRoutePolicy.allowsSullaCloudDesktopRequest(method, route), `${method} ${route}`).toBe(false);
    }
  });

  it('allows only the organization membership and messaging routes used by Desktop', () => {
    const allowed: Array<[string, string]> = [
      ['GET', '/cloud-dashboard/v1/organizations'],
      ['GET', '/orgs/team-1/inbox'], ['GET', '/orgs/team-1/directory'], ['GET', '/orgs/team-1/contact-requests'],
      ['POST', '/orgs/team-1/conversations'],
      ['POST', '/orgs/team-1/conversations/convo-1/messages'], ['POST', '/orgs/team-1/conversations/convo-1/control'],
      ['POST', '/orgs/team-1/conversations/convo-1/agent-messages'],
      ['POST', '/orgs/team-1/contact-requests/person-1/resolve'], ['POST', '/orgs/team-1/agent-host-lease'],
    ];
    for (const [method, route] of allowed) {
      expect(SullaCloudDesktopRoutePolicy.allowsSullaCloudDesktopRequest(method, route), `${method} ${route}`).toBe(true);
    }
  });

  it('denies organization route near-misses and wrong methods', () => {
    const denied: Array<[string, string]> = [
      ['POST', '/orgs/x/inbox'], ['GET', '/orgs/x/conversations'], ['POST', '/orgs/x/../admin'],
      ['POST', '/orgs/x/conversations/y/delete'], ['GET', '/cloud-dashboard/v1/devices'],
      ['GET', '/orgs/x/conversations/y/messages'], ['POST', '/orgs/x/contact-requests/y/resolve/extra'],
    ];
    for (const [method, route] of denied) {
      expect(SullaCloudDesktopRoutePolicy.allowsSullaCloudDesktopRequest(method, route), `${method} ${route}`).toBe(false);
    }
  });

  it('allows only the org memberships read and the team invitations read used by the People list', () => {
    // risk: permissions and tenant isolation; roles and pending invites are read-only, admin gating happens server-side
    const allowed: Array<[string, string]> = [
      ['GET', '/cloud-dashboard/v1/organizations/org-1/memberships'],
      ['GET', '/cloud-dashboard/v1/organizations/org_1.2~x-3/memberships'],
      ['GET', '/teams/team-1/invitations'],
    ];
    for (const [method, route] of allowed) {
      expect(SullaCloudDesktopRoutePolicy.allowsSullaCloudDesktopRequest(method, route), `${method} ${route}`).toBe(true);
    }
  });

  it('allows only Conversations server reads and notification preference writes used by the channel UI', () => {
    // risk: permissions and tenant isolation; keep the new Cloud capability scoped to P2 read/preferences routes
    const allowed: Array<[string, string]> = [
      ['GET', '/conversation-servers'], ['GET', '/conversation-servers/server-1'],
      ['GET', '/conversation-servers/server-1/channels'], ['GET', '/conversation-servers/server-1/members'],
      ['PATCH', '/conversation-servers/server-1/notification-default'],
      ['GET', '/conversation-servers/server-1/channels/channel-1/notification-preference'],
      ['PUT', '/conversation-servers/server-1/channels/channel-1/notification-preference'],
    ];
    for (const [method, route] of allowed) expect(SullaCloudDesktopRoutePolicy.allowsSullaCloudDesktopRequest(method, route), `${method} ${route}`).toBe(true);
    const denied: Array<[string, string]> = [
      ['POST', '/conversation-servers'], ['POST', '/conversation-servers/server-1/channels'],
      ['GET', '/conversation-servers/server-1/channels/channel-1/notification-preference/extra'],
      ['DELETE', '/conversation-servers/server-1/members/member-1'],
    ];
    for (const [method, route] of denied) expect(SullaCloudDesktopRoutePolicy.allowsSullaCloudDesktopRequest(method, route), `${method} ${route}`).toBe(false);
  });

  it('denies invitation writes and near-miss paths for memberships and invitations', () => {
    // risk: permissions; an invitation write or a sibling device route must never pass the desktop allowlist
    const denied: Array<[string, string]> = [
      ['POST', '/teams/team-1/invitations'],
      ['DELETE', '/teams/team-1/invitations/invite-1'],
      ['GET', '/teams/team-1/invitations/invite-1'],
      ['GET', '/teams/team-1/invitations/invite-1/resend'],
      ['POST', '/cloud-dashboard/v1/organizations/org-1/memberships'],
      ['GET', '/cloud-dashboard/v1/organizations/org-1/devices'],
      ['GET', '/cloud-dashboard/v1/organizations/org-1/memberships/user-1'],
    ];
    for (const [method, route] of denied) {
      expect(SullaCloudDesktopRoutePolicy.allowsSullaCloudDesktopRequest(method, route), `${method} ${route}`).toBe(false);
    }
  });

  it('checks every static cloudRequest method/path and inventories every dynamic callsite', () => {
    const dynamicCallSites: string[] = [];
    let scanned = 0;
    for (const file of sourceFiles(mainRoot)) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && isRequestCall(node)) {
          scanned++;
          const [methodArg, pathArg] = node.arguments;
          const method = stringLiteral(methodArg);
          const requestPath = stringLiteral(pathArg);
          if (method !== undefined && requestPath !== undefined) {
            const pathname = new URL(requestPath, 'https://sulladesktop.com').pathname;
            expect(SullaCloudDesktopRoutePolicy.allowsSullaCloudDesktopRequest(method, pathname),
              `${path.relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${method} ${pathname}`).toBe(true);
          } else {
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            dynamicCallSites.push(`${path.relative(mainRoot, file).replaceAll(path.sep, '/').replace(/^cloud\//, 'cloud/')}:${line}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(scanned).toBeGreaterThan(0);
    expect(dynamicCallSites.sort()).toEqual([...reviewedDynamicCallSites].sort());
  });
});
