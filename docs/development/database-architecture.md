# Database Architecture

## Overview

Sulla uses PostgreSQL as its primary data store and Redis as a caching/pub-sub layer. Both run as Docker containers inside the Sulla VM, managed by the Docker Compose file at `pkg/sulla-desktop/assets/sulla-docker-compose.yaml`.

## Infrastructure

### PostgreSQL (Port 30116)

- **Image**: `ghcr.io/merchantprotocol/sulla-postgres` (`postgres:16-alpine` + pgvector)
- **Container**: `sulla_postgres`
- **Port mapping**: Host `30116` -> Container `5432`
- **Database**: `sulla`
- **User**: `sulla`
- **Data volume**: `/var/lib/sulla/postgres` (persistent inside the VM)
- **Auth method**: network clients (host port `30116`, and every container on `sulla_default`) authenticate with `scram-sha-256` using the install's service secret. The container's local socket stays `trust`, so `docker exec sulla_postgres psql -U sulla` needs no password. Agent containers share `sulla_default` and get no credentials, so they cannot log in.
  - Fresh installs: the compose file sets no `POSTGRES_HOST_AUTH_METHOD`, so the image entrypoint appends `host all all all scram-sha-256` at initdb, and `POSTGRES_PASSWORD` is the service secret. `ComposeSecretGuard` refuses any compose file that sets `POSTGRES_HOST_AUTH_METHOD=trust`.
  - Volumes initialised by older builds keep the `pg_hba.conf` stored in the volume (`host all all all trust`) until Desktop's Postgres auth migration rewrites it to the managed form (`# managed-by: sulla-desktop postgres-auth v1`, backup `pg_hba.conf.sulla-pre-scram`). An install whose stored secret is still the legacy development password stays on trust until that secret is rotated.
- **Health check**: `pg_isready -U sulla` every 10 seconds

### Redis (Port 30117)

- **Image**: `redis:7-alpine`
- **Container**: `sulla_redis`
- **Port mapping**: Host `30117` -> Container `6379`
- **Persistence**: AOF (`--appendonly yes`) with RDB snapshots every 60 seconds if at least 1 key changed
- **Data volume**: `/var/lib/sulla/redis` (persistent inside the VM)
- **Health check**: `redis-cli ping` every 10 seconds

### Shared by n8n

The same PostgreSQL and Redis instances are shared with the n8n workflow engine (port 30119). n8n connects to both services using their Docker Compose service names (`postgres` and `redis`) on internal ports, and stores its data in the same `sulla` database.

## Client Connections

### PostgresClient

Source: `pkg/sulla-desktop/agent/database/PostgresClient.ts`

A singleton wrapper around `pg.Pool` that provides connection pooling and query helpers.

**Connection settings:**
- Host: `127.0.0.1`
- Port: `30116`
- User: `sulla`
- Password: the install's service secret, from `serviceSecretProvider.value()` (`agent/app/Providers/ServiceSecretServiceProvider.ts`); there is no fallback password. `SULLA_DATABASE_URL`, when set, replaces these settings.
- Database: `sulla`
- Max pool size: 20 connections
- Idle timeout: 30 seconds
- Connection timeout: 2 seconds

**Key methods:**
- `query<T>(sql, params)` — Execute a query, return `rows`
- `queryOne<T>(sql, params)` — Return first row or `null`
- `queryWithResult<T>(sql, params)` — Return the full `pg.QueryResult` (includes `rowCount`, `fields`, etc.)
- `transaction(callback)` — Run a callback inside `BEGIN`/`COMMIT` with automatic `ROLLBACK` on error
- `getClient()` — Acquire a raw `PoolClient` for advanced use (caller must call `client.release()`)

**Singleton export:** `postgresClient`

### RedisClient

Source: `pkg/sulla-desktop/agent/database/RedisClient.ts`

A singleton wrapper around `ioredis` with lazy connection, automatic reconnection, and a clean command API.

**Connection settings:**
- URL: `redis://127.0.0.1:30117`
- Retry strategy: exponential backoff (`times * 50ms`, max 2 seconds)
- Max retries per request: 3
- Max connection attempts: 10 (then gives up)
- Lazy connect: does not connect on construction

**Key methods:**
- `set(key, value, ttlSeconds?)` / `get(key)` / `del(keys)` — Basic key-value operations
- `incr(key)` / `decr(key)` — Atomic counters
- `hset` / `hget` / `hgetall` / `hmget` / `hdel` — Hash operations
- `rpush` / `lpop` — List operations (queue pattern)
- `publish(channel, message)` — Pub/sub publishing
- `scan(cursor, ...args)` — Cursor-based key scanning with MATCH/COUNT support
- `pipeline()` — Create a pipeline for batched commands
- `keys(pattern)` — Pattern-based key lookup

**Singleton export:** `redisClient`

## Credential Management

The PostgreSQL password is the install's **service secret**, owned by `ServiceSecretProvider` (`agent/app/Services/ServiceSecret/ServiceSecretProvider.ts`):

- It is generated once on a fresh install (32 random bytes, base64url). There is no default or fallback password.
- It is stored as the `sullaServicePassword` setting, both in the local settings bootstrap file and in the `sulla_settings` table; the database copy wins on a mismatch. On an installed system Desktop reads it over the container's local socket.
- `ServiceSecretComposeValues` is the only place that writes it into the compose file (`POSTGRES_PASSWORD` and every service `DATABASE_URL`), and `ComposeSecretGuard` refuses to write a compose file with a missing, wrong or fallback credential.
- Never put the secret in a command line or a log. For manual SQL, use `docker exec sulla_postgres psql -U sulla` (`just pg-conn`).
- `SullaSettingsModel.generatePassword(length)` generates cryptographically random passwords.
- `SullaSettingsModel.generateEncryptionKey(length)` generates base64 encryption keys.

During initial setup, settings are stored in a local JSON lock file (offline-first fallback). Once PostgreSQL and Redis are available, `SullaSettingsModel.bootstrap()` syncs the lock file contents into the databases and marks the system as installed.

## Database Models

All models extend `BaseModel` (in `pkg/sulla-desktop/agent/database/BaseModel.ts`) which provides an ActiveRecord-style ORM over PostgresClient.

### Sulla-Owned Tables

| Table | Model | Purpose |
|-------|-------|---------|
| `sulla_settings` | `SullaSettingsModel` | Key-value settings store with type casting. Uses Redis `sulla_settings` hash as a read cache. |
| `agent_awareness` | `AgentAwareness` | Persistent agent memory and context |
| `agent_persona` | `AgentPersonaModel` | Agent personality and behavior configuration |
| `calendar_events` | `CalendarEvent` | Calendar integration data |
| `integration_values` | `IntegrationValueModel` | Third-party integration configuration values |
| `webhook_entity` | `WebhookEntityModel` | Registered webhook endpoints |
| `workflow_checkpoints` | `WorkflowCheckpointModel` | State checkpoints for long-running workflows |
| `oauth_tokens` | *(migration only)* | OAuth token storage for integrations |
| `knowledgebase_sections` | *(migration only)* | Knowledge base content sections |
| `knowledgebase_categories` | *(migration only)* | Knowledge base categorization |

### n8n-Owned Tables (Shared Database)

These tables are managed by n8n but accessed read-only by Sulla's agent system:

| Table | Model | Purpose |
|-------|-------|---------|
| `workflow_entity` | `N8nWorkflowModel` | n8n workflow definitions |
| `credentials_entity` | `N8nCredentialsEntityModel` | n8n stored credentials |
| `user` | `N8nUserModel` | n8n user accounts |
| `user_api_keys` | `N8nUserApiKeyModel` | n8n API keys |
| `project` | `N8nProjectModel` | n8n project containers |
| `project_relation` | `N8nProjectRelationModel` | n8n project membership |
| `settings` | `N8nSettingsModel` | n8n application settings |

## Migration System

Schema migrations live in `pkg/sulla-desktop/agent/database/migrations/` and are tracked in the `sulla_migrations` table. The `DatabaseManager` (`pkg/sulla-desktop/agent/database/DatabaseManager.ts`) runs pending migrations on startup.

Migration files follow a numbered naming convention (e.g., `0001_create_migrations_and_seeders_table.ts`, `0011_create_settings_table.ts`).

## Data Flow: Settings as an Example

`SullaSettingsModel` demonstrates the tiered storage pattern used throughout the system:

1. **Before databases are ready** (early startup): Settings are read from and written to a local JSON lock file on disk.
2. **After bootstrap**: `SullaSettingsModel.bootstrap()` syncs the lock file into PostgreSQL and populates the Redis hash.
3. **Normal operation reads**: Redis hash (`sulla_settings`) is checked first. On cache miss, PostgreSQL is queried and the result is written back to Redis.
4. **Writes**: Write-through to both PostgreSQL and Redis simultaneously.
5. **Pattern queries**: `getByPattern('active_plan:*')` scans Redis first, falls back to PostgreSQL `LIKE` queries.

This ensures the system functions during early startup (before Docker containers are healthy) while providing fast reads through Redis caching once fully operational.
