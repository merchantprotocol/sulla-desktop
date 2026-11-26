// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { clerkSettings, type ClerkSettings } from '@pkg/agent/integrations/clerk/ClerkClient';
import { CLERK_ACCOUNT } from '@pkg/agent/integrations/clerk/ClerkEndpoints';
import { configuredVaultBrokerProvider, VaultBrokerError, type LocalVaultApprovalClient, type LocalVaultBrokerClient } from '@pkg/vault-broker';

import type { BrokerIntegrationMetadataResponse } from '../../../services/sulla-vault/src/contracts';

const CLERK_ENVIRONMENTS = ['staging', 'production'] as const;
const NOT_CONFIRMED = 'The Vault did not confirm the Clerk keys were saved. Check the status above and try again.';

/**
 * The stored Clerk account's item revision; 0 when the account does not exist. items.revision is a
 * bigint, so the vault sends it as a decimal string; compare it as a number, never as text.
 */
function revision(stored: BrokerIntegrationMetadataResponse): bigint {
  const value: unknown = stored.accounts.find(account => account.accountId === CLERK_ACCOUNT)?.revision;
  if (value === undefined) return BigInt(0);
  if ((typeof value === 'number' && Number.isSafeInteger(value) && value > 0) || (typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value))) {
    return BigInt(value);
  }
  throw new Error('The Vault returned an invalid Clerk account revision.');
}

/** A per-service allowlist; no input or response body is ever a diagnostic by default. */
class ClerkSettingsDiagnostics {
  private readonly codes = new Set([
    'vault_locked', 'vault_unavailable', 'invalid_operation', 'policy_denied', 'approval_required', 'upstream_failed',
    'upstream_timeout', 'database_unavailable', 'credential_field_missing', 'invalid_caller_identity', 'already_exists', 'not_found',
  ]);

  /** Diagnostics never echo response or input text: only allowlisted codes, numeric status and plain-word messages. */
  cause(error: unknown): string {
    if (!(error instanceof VaultBrokerError)) return error instanceof TypeError ? 'TypeError' : 'unexpected error';
    const code = this.codes.has(error.code) ? error.code : 'other code';
    const status = Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? String(error.status) : 'no status';
    return `${ code } ${ status }`;
  }

  /** Messages the Desktop or the vault's Clerk validation can show. Anything else is logged as "unlisted message". */
  private readonly messages = new Set([
    'Enter Clerk keys for at least one environment.', 'The Clerk settings contain an invalid key field.',
    'Enter a Clerk key pair to make changes.', 'Clerk requires the Desktop Vault.', 'Unlock the Vault, then try again.',
    'Clerk settings could not be saved or read. Check the local Vault and try again.', 'Clerk settings contained an unexpected field.',
  ]);
  private readonly sectionMessages = new Set([
    'the publishable key is empty. Enter both keys for this section, or clear both to leave it unset.',
    'the secret key is empty. Enter both keys for this section, or clear both to leave it unset.',
    'the publishable key field contains a secret key (sk_…). Paste the key that starts with pk_test_ or pk_live_.',
    'the secret key field contains a publishable key (pk_…). Paste the key that starts with sk_test_ or sk_live_.',
    'the publishable key must start with pk_test_ or pk_live_.',
    'the secret key must start with sk_test_ or sk_live_.',
    'the publishable key contains spaces or line breaks. Copy it again from the Clerk dashboard.',
    'the secret key contains spaces or line breaks. Copy it again from the Clerk dashboard.',
    'the publishable key is malformed (it does not decode to a Clerk frontend address). Copy it again from the Clerk dashboard.',
    'the secret key is malformed (it has unexpected characters). Copy it again from the Clerk dashboard.',
    'Clerk could not be reached to verify the keys. Check the connection and try again.',
    'Clerk did not return the expected instance type.',
    'the publishable key and the secret key are from different Clerk instances. Copy both from the same instance in the Clerk dashboard.',
    'Clerk rejected the saved key pair. This section was disconnected; enter active keys to reconnect.',
  ]);
  private readonly sectionPatterns = [
    /^the publishable key is pk_(?:test|live)_ but the secret key is sk_(?:test|live)_\. Both keys must come from the same Clerk instance\.$/,
    /^Clerk rejected the secret key \(HTTP 40[13]\)\. Check that it is the current, active secret key for this instance\.$/,
    /^Clerk could not verify the secret key \(HTTP \d{3}\)\. Try again in a moment\.$/,
  ];

  message(message: string): string {
    const section = /^(?:Staging|Production): (.*)$/.exec(message);
    if (this.messages.has(message) || message === NOT_CONFIRMED || (section && (this.sectionMessages.has(section[1]) || this.sectionPatterns.some(pattern => pattern.test(section[1]))))) return message;
    return /^Clerk is rate limiting this request\. Retry in \d{1,16} seconds?\.$/.test(message) ? message : 'unlisted message';
  }
}

function redact(text: string): string {
  return text.replace(/(?:sk|pk)_(?:live|test)_[A-Za-z0-9+/=_-]+/g, '[REDACTED]');
}

type ClerkSection = typeof CLERK_ENVIRONMENTS[number];
/** What happened to one section of a save. Each section is written and confirmed on its own. */
export type ClerkSectionOutcome = { saved: true } | { saved: false; error: string };
export type ClerkSectionOutcomes = Partial<Record<ClerkSection, ClerkSectionOutcome>>;
export type ClerkSettingsResult =
  | { success: true; settings: ClerkSettings; sections?: ClerkSectionOutcomes }
  | { success: false; error: string; settings?: ClerkSettings; sections?: ClerkSectionOutcomes };

const LABELS: Record<ClerkSection, string> = { staging: 'Staging', production: 'Production' };

export class ClerkSettingsService {
  constructor(
    private readonly owner: () => Pick<LocalVaultApprovalClient, 'importIntegrationAccount'> | null,
    private readonly broker: () => Pick<LocalVaultBrokerClient, 'integrationMetadata'>,
    // Outcome only: never the submitted values. Lets a failed save be diagnosed from the Desktop log.
    private readonly log: (line: string) => void = line => console.info(line),
    private readonly diagnostics = new ClerkSettingsDiagnostics(),
  ) {}

  async load(): Promise<ClerkSettingsResult> {
    try {
      return { success: true, settings: clerkSettings(await this.broker().integrationMetadata('clerk', CLERK_ACCOUNT)) };
    } catch (error) {
      return this.failure(error);
    }
  }

  async save(input: unknown, disconnect = false): Promise<ClerkSettingsResult> {
    if (disconnect) return this.logged('disconnect', [...CLERK_ENVIRONMENTS], await this.attempt(input, true)).result;
    const parsed = this.parse(input);
    if ('rejected' in parsed) {
      const sections = this.sectionsIn(input);
      return this.logged('save', sections, { result: { success: false, error: parsed.rejected }, cause: 'rejected before the vault' }).result;
    }
    // Each section is its own write and read-back, so a bad pair in one section never blocks the other.
    const outcomes: ClerkSectionOutcomes = {};
    const failures: string[] = [];
    let settings: ClerkSettings | undefined;
    for (const section of this.sectionsIn(parsed.values)) {
      const values = Object.fromEntries(Object.entries(parsed.values).filter(([name]) => name.startsWith(`${ section }_`)));
      const { result } = this.logged('save', [section], await this.write(values, false));
      settings = result.settings ?? settings;
      if (result.success) {
        outcomes[section] = { saved: true };
      } else {
        const error = /^(?:Staging|Production): /.test(result.error) ? result.error : `${ LABELS[section] }: ${ result.error }`;
        outcomes[section] = { saved: false, error };
        failures.push(error);
      }
    }
    if (!failures.length && settings) return { success: true, settings, sections: outcomes };
    if (!settings) {
      const current = await this.load();
      if (current.success) settings = current.settings;
    }
    return { success: false, error: failures.join(' ') || NOT_CONFIRMED, ...(settings ? { settings } : {}), sections: outcomes };
  }

  /** Recognized sections named by a save input, in a fixed order. */
  private sectionsIn(input: unknown): ClerkSection[] {
    return CLERK_ENVIRONMENTS.filter(environment => !!input && typeof input === 'object' &&
      (Object.hasOwn(input, `${ environment }_publishable_key`) || Object.hasOwn(input, `${ environment }_secret_key`)));
  }

  private logged(action: 'save' | 'disconnect', sections: readonly string[], outcome: { result: ClerkSettingsResult; cause: string }) {
    const { result, cause } = outcome;
    this.log(`[clerk-settings] ${ action } sections=${ sections.join(',') || 'none' } ` +
      (result.success ? 'confirmed' : `failed: ${ cause } -> ${ this.diagnostics.message(result.error) }`));
    return outcome;
  }

  private parse(input: unknown): { values: Record<string, string> } | { rejected: string } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { rejected: 'Enter Clerk keys for at least one environment.' };
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(input)) {
      if (!/^(staging|production)_(publishable|secret)_key$/.test(name) || typeof value !== 'string' || value.length > 1024) {
        return { rejected: 'The Clerk settings contain an invalid key field.' };
      }
      values[name] = value;
    }
    return Object.keys(values).length ? { values } : { rejected: 'Enter a Clerk key pair to make changes.' };
  }

  private async attempt(input: unknown, disconnect: boolean): Promise<{ result: ClerkSettingsResult; cause: string }> {
    const parsed = this.parse(input);
    if ('rejected' in parsed && !(disconnect && parsed.rejected === 'Enter a Clerk key pair to make changes.')) {
      return { result: { success: false, error: parsed.rejected }, cause: 'rejected before the vault' };
    }
    return this.write('values' in parsed ? parsed.values : {}, disconnect);
  }

  /** The save itself; `cause` names what failed (error code and status, never values) for the outcome log. */
  private async write(values: Record<string, string>, disconnect: boolean): Promise<{ result: ClerkSettingsResult; cause: string }> {
    try {
      const owner = this.owner();
      if (!owner) return { result: { success: false, error: 'Clerk requires the Desktop Vault.' }, cause: 'no approval client' };
      const before = revision(await this.broker().integrationMetadata('clerk', CLERK_ACCOUNT));
      await owner.importIntegrationAccount('clerk', {
        accountId: CLERK_ACCOUNT, label: 'Clerk', values, connected: !disconnect, active: true,
      });
      // Report success only from an independent read of the stored account, never from the write reply.
      // Each committed write advances the item revision, so an unchanged revision means nothing was stored.
      const stored = await this.broker().integrationMetadata('clerk', CLERK_ACCOUNT);
      const settings = clerkSettings(stored);
      if (revision(stored) <= before) return { result: { success: false, error: NOT_CONFIRMED, settings }, cause: 'revision unchanged' };
      return this.confirmed(settings, values, disconnect)
        ? { result: { success: true, settings }, cause: '' }
        : { result: { success: false, error: NOT_CONFIRMED, settings }, cause: 'sections do not match' };
    } catch (error) {
      const cause = this.diagnostics.cause(error);
      const failure = this.failure(error);
      if (!(error instanceof VaultBrokerError) || error.code !== 'invalid_operation' || error.status !== 400 ||
          !error.message.includes('This section was disconnected;')) return { result: failure, cause };
      const current = await this.load();
      return { result: current.success ? { ...failure, settings: current.settings } : failure, cause };
    }
  }

  /** True when the stored account reflects every section this save submitted. */
  private confirmed(settings: ClerkSettings, values: Record<string, string>, disconnect: boolean): boolean {
    return CLERK_ENVIRONMENTS.every((environment) => {
      if (disconnect) return !settings[environment].connected;
      const publishable = values[`${ environment }_publishable_key`];
      const secret = values[`${ environment }_secret_key`];
      if (publishable === undefined && secret === undefined) return true;
      if (!publishable?.trim() && !secret?.trim()) return !settings[environment].connected;
      return settings[environment].connected && settings[environment].publishableKey === (publishable ?? '').trim();
    });
  }

  private failure(error: unknown): ClerkSettingsResult {
    if (error instanceof VaultBrokerError) {
      if (error.code === 'vault_locked') return { success: false, error: 'Unlock the Vault, then try again.' };
      if (error.code === 'invalid_operation' && error.status === 400) {
        return { success: false, error: redact(error.message) };
      }
      if (error.status === 429 && /^Clerk is rate limiting this request\. Retry in \d{1,16} seconds?\.$/.test(error.message)) {
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: 'Clerk settings could not be saved or read. Check the local Vault and try again.' };
  }
}

export function createClerkSettingsService(): ClerkSettingsService {
  const provider = configuredVaultBrokerProvider;
  return new ClerkSettingsService(
    () => provider.getConfiguredApprovalClient(),
    () => provider.requireConfiguredCredentialBroker(),
  );
}
