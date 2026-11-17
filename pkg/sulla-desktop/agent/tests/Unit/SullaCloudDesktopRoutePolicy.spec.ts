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
