// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { SullaCloudHttpClient } from '@pkg/main/cloud/account/SullaCloudHttpClient';
import type { OrgMembership } from './OrgMembershipDirectory';

/** The bearer and the user id one org's transport authenticates with on its host. */
export interface OrgHostCredentials {
  accessToken(): Promise<string>;
  /** The caller's id on that host: the Cloud user id, or the Server provider's subject. */
  userId(): Promise<string>;
}

/** Where one org's conversations live and how Desktop signs in there. */
export interface OrgHosting {
  kind: 'cloud' | 'server';
  /** Origin the `/orgs/:orgId/*` routes are served from. */
  baseUrl: string;
  credentials: OrgHostCredentials;
}

/** Resolves one org's hosting, or `undefined` when the org cannot be synced right now (the fleet skips it). */
export interface OrgHostingSource {
  resolve(membership: OrgMembership): Promise<OrgHosting | undefined>;
}

/** One org this Desktop has joined on a Sulla Server, as Desktop Accounts knows it. */
export interface ServerOrgHost {
  orgId: string;
  /** The Server's stable authority id (`remoteAuthorityId` of the Accounts connection). */
  authorityId: string;
  /** The Server's hosted OIDC issuer; its origin is the gateway that serves `/orgs/`. */
  issuer: string;
  /** The signed-in person's subject on that Server. */
  subject: string;
}

/** Lists the orgs this Desktop has joined on a Sulla Server. Throws when the list cannot be read. */
export interface ServerOrgHostDirectory {
  hosts(): Promise<readonly ServerOrgHost[]>;
}

/** Hands out the Server provider's access token for one joined Server org; '' when none is available. */
export interface ServerAccessTokenSource {
  accessToken(host: ServerOrgHost): Promise<string>;
}

export interface OrgHostingLogger {
  warn(message: string): void;
}

/** Cloud sign-in: the Sulla Cloud access token and user id. */
export class CloudOrgHostCredentials implements OrgHostCredentials {
  async accessToken(): Promise<string> { return (await import('@pkg/main/sullaCloudAuth')).getCurrentAccessToken(); }
  async userId(): Promise<string> { return (await import('@pkg/main/sullaCloudAuth')).getCurrentUserId(); }
}

/** Server sign-in for one joined org: the provider access token from the token source, and the Server subject. */
export class ServerOrgHostCredentials implements OrgHostCredentials {
  constructor(private readonly host: ServerOrgHost, private readonly tokens: ServerAccessTokenSource) {}
  accessToken(): Promise<string> { return this.tokens.accessToken(this.host); }
  async userId(): Promise<string> { return this.host.subject; }
}

/**
 * Reads joined Server orgs from Desktop Accounts: each remote membership whose authority matches a connected
 * Server (`remoteAuthorityId`, falling back to the issuer). Membership rows are display hints; the Server
 * still checks live membership on every `/orgs/` request.
 */
export class AccountsServerOrgHostDirectory implements ServerOrgHostDirectory {
  async hosts(): Promise<readonly ServerOrgHost[]> {
    const accounts = (await import('@pkg/main/sullaAccountsClient')).getSullaAccountsClient();
    const [{ connections }, { remoteDisplayHints }] = await Promise.all([accounts.listConnections(), accounts.listMemberships()]);
    const hosts: ServerOrgHost[] = [];
    for (const membership of remoteDisplayHints) {
      const connection = connections.find(item => item.remoteAuthorityId === membership.authorityId)
        ?? connections.find(item => item.issuer === membership.issuer);
      if (!connection) continue;
      hosts.push({
        orgId:       membership.organizationId,
        authorityId: membership.authorityId,
        issuer:      connection.issuer,
        subject:     membership.subject,
      });
    }
    return hosts;
  }
}

/**
 * Desktop Accounts keeps every authority access token sealed (docs/accounts-contract.md): no API hands one
 * out yet. Until one does, Server-hosted orgs resolve with no token and the fleet skips them with a log.
 */
export class AccountsServerAccessTokenSource implements ServerAccessTokenSource {
  async accessToken(): Promise<string> { return ''; }
}

/**
 * Decides, per org, whether its conversations live in Sulla Cloud or on a Sulla Server, and with which base URL
 * and credentials. Cloud is the default; an org is Server-hosted only when Desktop Accounts lists it under a
 * connected Server. A Server org with an unusable issuer or no access token is skipped (logged once per reason),
 * never routed to Cloud. When the Server list cannot be read, the last good list is used.
 */
export class OrgHostingResolver implements OrgHostingSource {
  private knownHosts: readonly ServerOrgHost[] = [];
  private readonly reported = new Map<string, string>();
  private directoryFailure?: string;

  constructor(
    private readonly serverHosts: ServerOrgHostDirectory = new AccountsServerOrgHostDirectory(),
    private readonly serverTokens: ServerAccessTokenSource = new AccountsServerAccessTokenSource(),
    private readonly cloudCredentials: OrgHostCredentials = new CloudOrgHostCredentials(),
    private readonly cloudBaseUrl: string = SullaCloudHttpClient.API_BASE,
    private readonly logger: OrgHostingLogger = console,
  ) {}

  async resolve(membership: OrgMembership): Promise<OrgHosting | undefined> {
    const host = (await this.serverHostsNow()).find(item => item.orgId === membership.orgId);
    if (!host) {
      this.reported.delete(membership.orgId);
      return { kind: 'cloud', baseUrl: this.cloudBaseUrl, credentials: this.cloudCredentials };
    }
    const baseUrl = OrgHostingResolver.serverOrigin(host.issuer);
    if (!baseUrl || !host.subject) {
      this.skip(membership, `its Sulla Server (${ host.authorityId }) has no usable address or sign-in`);
      return undefined;
    }
    const credentials = new ServerOrgHostCredentials(host, this.serverTokens);
    let token: string;
    try {
      token = await credentials.accessToken();
    } catch (error) {
      this.skip(membership, `the Sulla Server at ${ baseUrl } is unreachable (${ error instanceof Error ? error.message : String(error) })`);
      return undefined;
    }
    if (!token) {
      this.skip(membership, `Desktop has no access token for the Sulla Server at ${ baseUrl }`);
      return undefined;
    }
    this.reported.delete(membership.orgId);
    return { kind: 'server', baseUrl, credentials };
  }

  private async serverHostsNow(): Promise<readonly ServerOrgHost[]> {
    try {
      this.knownHosts = [...await this.serverHosts.hosts()];
      this.directoryFailure = undefined;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (this.directoryFailure !== reason) {
        this.directoryFailure = reason;
        this.logger.warn(`[OrgHostingResolver] Could not read Sulla Server organizations (${ reason }); using the last known list.`);
      }
    }
    return this.knownHosts;
  }

  private skip(membership: OrgMembership, reason: string): void {
    if (this.reported.get(membership.orgId) === reason) return;
    this.reported.set(membership.orgId, reason);
    this.logger.warn(`[OrgHostingResolver] Skipping organization "${ membership.name }" (${ membership.orgId }): ${ reason }.`);
  }

  /** The issuer's origin, http(s) only, with no credentials in the URL. */
  private static serverOrigin(issuer: string): string | undefined {
    try {
      const url = new URL(issuer);
      if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return undefined;
      return url.origin;
    } catch {
      return undefined;
    }
  }
}
