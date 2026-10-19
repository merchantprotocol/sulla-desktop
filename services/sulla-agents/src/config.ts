import fs from 'node:fs';

export type AgentServiceMode = 'desktop' | 'server';

function required(name: string, value: string | undefined): string {
  const result = value?.trim() ?? '';
  if (!result) throw new Error(`${ name } is required`);
  return result;
}

function optionalSecretFile(name: string): string {
  const file = process.env[name]?.trim();
  if (!file) return '';
  const stat = fs.statSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error(`${ name } must be private`);
  return fs.readFileSync(file, 'utf8').trim();
}

const mode = (process.env.SULLA_AGENT_SERVICE_MODE ?? 'desktop') as AgentServiceMode;
if (mode !== 'desktop' && mode !== 'server') throw new Error('SULLA_AGENT_SERVICE_MODE must be desktop or server');
const installationSecret = process.env.SULLA_API_TOKEN?.trim() ?? '';

export const config = {
  mode,
  port:                 Number(process.env.SULLA_AGENT_SERVICE_PORT ?? 8789),
  databaseUrl:          process.env.SULLA_DATABASE_URL ?? 'postgresql://sulla:sulla_dev_password@postgres:5432/sulla',
  localToken:           mode === 'desktop' ? required('SULLA_API_TOKEN', installationSecret) : '',
  toolApiToken:         required('SULLA_API_TOKEN', installationSecret),
  toolApiUrl:           process.env.SULLA_TOOL_API_URL ?? 'http://sulla_tools:3000',
  image:                process.env.SULLA_AGENT_IMAGE ?? 'sulla-agent:local',
  dockerNetwork:        process.env.SULLA_DOCKER_NETWORK ?? 'sulla_default',
  accountsUrl:          mode === 'server' ? required('SULLA_ACCOUNTS_URL', process.env.SULLA_ACCOUNTS_URL).replace(/\/$/, '') : '',
  accountsServiceId:    mode === 'server' ? required('SULLA_ACCOUNTS_SERVICE_ID', process.env.SULLA_ACCOUNTS_SERVICE_ID) : '',
  accountsServiceToken: mode === 'server' ? required('SULLA_ACCOUNTS_SERVICE_TOKEN_FILE', optionalSecretFile('SULLA_ACCOUNTS_SERVICE_TOKEN_FILE')) : '',
  audience:             mode === 'server' ? (process.env.SULLA_AGENT_AUDIENCE?.trim() || 'sulla-agents') : '',
  requiredRoles:        (process.env.SULLA_AGENT_REQUIRED_ROLES ?? '').split(',').map(value => value.trim()).filter(Boolean),
  openAiApiKey:         optionalSecretFile('SULLA_OPENAI_API_KEY_FILE'),
  anthropicApiKey:      optionalSecretFile('SULLA_ANTHROPIC_API_KEY_FILE'),
};

if (Buffer.byteLength(config.toolApiToken) < 32) throw new Error('SULLA_API_TOKEN must contain at least 32 bytes');
