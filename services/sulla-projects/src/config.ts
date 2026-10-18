export interface ProjectsConfig {
  port: number;
  mode: 'desktop' | 'server';
  localToken?: string;
  humanToken?: string;
  jwtSecret?: string;
  jwtPublicKey?: string;
  jwtIssuer?: string;
  jwtAudience: string;
  userId: string;
  tenantId: string;
  databaseUrl: string;
  migrationDatabaseUrl: string;
  adminDatabaseUrl?: string;
  legacyDatabaseUrl?: string;
  databaseName: string;
  databaseOwner: string;
  runtimeRole: string;
  runtimePassword?: string;
  autoArchiveHours?: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${ name } is required`);
  return value;
}

function boundedPort(value: string | undefined): number {
  const port = Number(value ?? 8793);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SULLA_PROJECTS_PORT must be a valid TCP port');
  return port;
}

export function loadConfig(): ProjectsConfig {
  const mode = process.env.SULLA_PROJECTS_MODE === 'server' ? 'server' : 'desktop';
  const localToken = process.env.SULLA_PROJECTS_LOCAL_TOKEN?.trim();
  const humanToken = process.env.SULLA_PROJECTS_HUMAN_TOKEN?.trim();
  const jwtSecret = process.env.SULLA_PROJECTS_JWT_SECRET?.trim();
  const jwtPublicKey = process.env.SULLA_PROJECTS_JWT_PUBLIC_KEY?.replace(/\\n/g, '\n').trim();
  const jwtIssuer = process.env.SULLA_PROJECTS_JWT_ISSUER?.trim();
  if (mode === 'desktop' && !localToken) throw new Error('SULLA_PROJECTS_LOCAL_TOKEN is required in desktop mode');
  if (mode === 'server' && (!jwtIssuer || (!jwtSecret && !jwtPublicKey))) {
    throw new Error('Server mode requires SULLA_PROJECTS_JWT_ISSUER and a JWT verification key');
  }
  const config: ProjectsConfig = {
    port: boundedPort(process.env.SULLA_PROJECTS_PORT), mode, localToken, humanToken, jwtSecret, jwtPublicKey, jwtIssuer,
    jwtAudience: process.env.SULLA_PROJECTS_JWT_AUDIENCE?.trim() || 'sulla-projects',
    userId: process.env.SULLA_PROJECTS_USER_ID?.trim() || 'desktop-user',
    tenantId: process.env.SULLA_PROJECTS_TENANT_ID?.trim() || 'desktop-user',
    databaseUrl: required('SULLA_PROJECTS_DATABASE_URL'),
    migrationDatabaseUrl: required('SULLA_PROJECTS_MIGRATION_DATABASE_URL'),
    adminDatabaseUrl: process.env.SULLA_PROJECTS_ADMIN_DATABASE_URL?.trim(),
    legacyDatabaseUrl: process.env.SULLA_PROJECTS_LEGACY_DATABASE_URL?.trim(),
    databaseName: process.env.SULLA_PROJECTS_DATABASE_NAME?.trim() || 'sulla_projects',
    databaseOwner: process.env.SULLA_PROJECTS_DATABASE_OWNER?.trim() || 'sulla',
    runtimeRole: process.env.SULLA_PROJECTS_DATABASE_ROLE?.trim() || 'sulla_projects_service',
    runtimePassword: process.env.SULLA_PROJECTS_DATABASE_PASSWORD,
    autoArchiveHours: process.env.SULLA_PROJECTS_AUTO_ARCHIVE_HOURS === undefined
      ? undefined
      : Math.max(0, Number(process.env.SULLA_PROJECTS_AUTO_ARCHIVE_HOURS)),
  };
  if (config.runtimeRole === config.databaseOwner) {
    throw new Error('Projects runtime role must be distinct from the database owner');
  }
  const runtimeUrl = new URL(config.databaseUrl);
  const migrationUrl = new URL(config.migrationDatabaseUrl);
  if (decodeURIComponent(runtimeUrl.username) !== config.runtimeRole
    || runtimeUrl.host !== migrationUrl.host || runtimeUrl.pathname !== migrationUrl.pathname
    || decodeURIComponent(runtimeUrl.pathname.slice(1)) !== config.databaseName) {
    throw new Error('Projects runtime and migration connections must target the configured isolated database');
  }
  if (config.legacyDatabaseUrl) {
    const legacyUrl = new URL(config.legacyDatabaseUrl);
    if (legacyUrl.host === migrationUrl.host && legacyUrl.pathname === migrationUrl.pathname) {
      throw new Error('Projects legacy source must be separate from the service database');
    }
  }
  return config;
}
