# Database Architecture

## Overview

Sulla uses PostgreSQL as its primary data store and Redis as a caching/pub-sub layer. Both run as Docker containers inside the Lima VM, managed by the Docker Compose file at `pkg/rancher-desktop/assets/sulla-docker-compose.yaml`.

## Infrastructure

### PostgreSQL (Port 30116)

- **Image**: `postgres:16-alpine`
- **Container**: `sulla_postgres`
- **Port mapping**: Host `30116` -> Container `5432`
- **Database**: `sulla`
- **User**: `sulla`
- **Data volume**: `/var/lib/sulla/postgres` (persistent inside the VM)
- **Auth method**: `trust` (no password required within the VM network)
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

Source: `pkg/rancher-desktop/agent/database/PostgresClient.ts`

A singleton wrapper around `pg.Pool` that provides connection pooling and query helpers.

**Connection settings:**
- Host: `127.0.0.1`
- Port: `30116`
- User: `sulla`
- Password: Retrieved from `SullaSettingsModel.get('sullaServicePassword', 'sulla_dev_password')`
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

Source: `pkg/rancher-desktop/agent/database/RedisClient.ts`

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

Database passwords are managed through `SullaSettingsModel`:

- The `sullaServicePassword` setting stores the PostgreSQL password.
- Default fallback is `sulla_dev_password` (matches the Docker Compose environment variable).
- `SullaSettingsModel.generatePassword(length)` generates cryptographically random passwords.
- `SullaSettingsModel.generateEncryptionKey(length)` generates base64 encryption keys.

During initial setup, settings are stored in a local JSON lock file (offline-first fallback). Once PostgreSQL and Redis are available, `SullaSettingsModel.bootstrap()` syncs the lock file contents into the databases and marks the system as installed.

## Database Models

All models extend `BaseModel` (in `pkg/rancher-desktop/agent/database/BaseModel.ts`) which provides an ActiveRecord-style ORM over PostgresClient.

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

Schema migrations live in `pkg/rancher-desktop/agent/database/migrations/` and are tracked in the `sulla_migrations` table. The `DatabaseManager` (`pkg/rancher-desktop/agent/database/DatabaseManager.ts`) runs pending migrations on startup.

Migration files follow a numbered naming convention (e.g., `0001_create_migrations_and_seeders_table.ts`, `0011_create_settings_table.ts`).

## Data Flow: Settings as an Example

`SullaSettingsModel` demonstrates the tiered storage pattern used throughout the system:

1. **Before databases are ready** (early startup): Settings are read from and written to a local JSON lock file on disk.
2. **After bootstrap**: `SullaSettingsModel.bootstrap()` syncs the lock file into PostgreSQL and populates the Redis hash.
3. **Normal operation reads**: Redis hash (`sulla_settings`) is checked first. On cache miss, PostgreSQL is queried and the result is written back to Redis.
4. **Writes**: Write-through to both PostgreSQL and Redis simultaneously.
5. **Pattern queries**: `getByPattern('active_plan:*')` scans Redis first, falls back to PostgreSQL `LIKE` queries.

This ensures the system functions during early startup (before Docker containers are healthy) while providing fast reads through Redis caching once fully operational.
