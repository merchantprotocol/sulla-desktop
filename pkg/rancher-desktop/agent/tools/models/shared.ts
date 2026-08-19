import { REMOTE_PROVIDERS } from '../../../shared/remoteProviders';
import { integrations } from '../../integrations/catalog';
import { modelDiscoveryService } from '../../languagemodels/ModelDiscoveryService';
import { getIntegrationService } from '../../services/IntegrationService';
import { runCommand } from '../util/CommandRunner';

const EXCLUDED_PROVIDER_IDS = new Set(['activepieces', 'composio', 'mcp', 'enterprise-gateway']);

export const CLI_PROVIDERS: Record<string, { command: string; versionCommand: string }> = {
  'claude-code': { command: 'claude', versionCommand: 'claude --version' },
  codex:         { command: 'codex', versionCommand: 'codex --version' },
};

const EXTRA_SUPPORTED_PROVIDER_IDS = new Set(['claude-code', 'codex', 'custom']);

export interface ProviderRuntimeStatus {
  providerId:       string;
  name:             string;
  description:      string;
  connected:        boolean;
  connectionState:  'on' | 'off';
  activeAccountId?: string;
  accounts: {
    accountId:    string;
    label:        string;
    active:       boolean;
    connected:    boolean;
    connectedAt?: string;
  }[];
  commandLine: {
    required:  boolean;
    command?:  string;
    installed: boolean;
    version?:  string;
    error?:    string;
  };
  sullaCompatible: boolean;
  ready:           boolean;
}

export function getAiProviderIntegrations() {
  return Object.values(integrations)
    .filter(integration => integration.category === 'AI Infrastructure')
    .filter(integration => !EXCLUDED_PROVIDER_IDS.has(integration.id))
    .sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999) || a.name.localeCompare(b.name));
}

export function isSullaCompatibleProvider(providerId: string): boolean {
  return modelDiscoveryService.getSupportedProviders().includes(providerId) ||
    EXTRA_SUPPORTED_PROVIDER_IDS.has(providerId);
}

export async function getCliStatus(providerId: string): Promise<ProviderRuntimeStatus['commandLine']> {
  const cli = CLI_PROVIDERS[providerId];
  if (!cli) return { required: false, installed: true };

  const res = await runCommand(
    `command -v ${ cli.command } >/dev/null 2>&1 && ${ cli.versionCommand }`,
    [],
    { runInLimaShell: true, timeoutMs: 10_000, maxOutputChars: 4_000 },
  );

  if (res.exitCode === 0) {
    return {
      required:  true,
      command:   cli.command,
      installed: true,
      version:   (res.stdout || res.stderr).trim(),
    };
  }

  return {
    required:  true,
    command:   cli.command,
    installed: false,
    error:     (res.stderr || res.stdout || `exit ${ res.exitCode }`).trim(),
  };
}

export async function getProviderRuntimeStatus(providerId: string): Promise<ProviderRuntimeStatus | null> {
  const integration = integrations[providerId];
  if (integration?.category !== 'AI Infrastructure' || EXCLUDED_PROVIDER_IDS.has(providerId)) {
    return null;
  }

  const service = getIntegrationService();
  await service.initialize();

  const [connected, accounts, activeAccountId, commandLine] = await Promise.all([
    service.isAnyAccountConnected(providerId).catch(() => false),
    service.getAccounts(providerId).catch(() => []),
    service.getActiveAccountId(providerId).catch(() => undefined),
    getCliStatus(providerId),
  ]);

  const sullaCompatible = isSullaCompatibleProvider(providerId);
  const ready = connected && sullaCompatible && (!commandLine.required || commandLine.installed);

  return {
    providerId,
    name:            integration.name,
    description:     integration.description,
    connected,
    connectionState: connected ? 'on' : 'off',
    activeAccountId,
    accounts:        accounts.map(account => ({
      accountId:    account.account_id,
      label:        account.label,
      active:       account.active,
      connected:    account.connected,
      connectedAt:  account.connected_at?.toISOString(),
    })),
    commandLine,
    sullaCompatible,
    ready,
  };
}

export function getStaticModels(providerId: string) {
  return REMOTE_PROVIDERS.find(provider => provider.id === providerId)?.models ?? [];
}
