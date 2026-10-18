# Sulla Projects service

Projects owns its PostgreSQL database, schema migrations, tenant isolation, claim leases, archive timer, and domain-event outbox. Desktop, tools, workflows, and server clients use the authenticated HTTP API; they must not write the Projects tables directly.

## Runtime contract

- `SULLA_PROJECTS_PORT` — container port, normally `8793` (Desktop publishes `127.0.0.1:30138`).
- `SULLA_PROJECTS_MODE` — `desktop` or `server`.
- `SULLA_PROJECTS_LOCAL_TOKEN` — service capability in Desktop mode.
- `SULLA_PROJECTS_HUMAN_TOKEN` — separate trusted UI capability in Desktop mode.
- `SULLA_PROJECTS_ADMIN_DATABASE_URL` — admin connection to the existing `sulla` database, used only to create the isolated database/runtime role.
- `SULLA_PROJECTS_MIGRATION_DATABASE_URL` — owner connection to the isolated `sulla_projects` database.
- `SULLA_PROJECTS_DATABASE_URL` — request connection as the non-superuser, non-`BYPASSRLS` `sulla_projects_service` role.
- `SULLA_PROJECTS_DATABASE_PASSWORD` — dedicated runtime-role password.
- `SULLA_PROJECTS_LEGACY_DATABASE_URL` — optional one-time source for the fenced, verified legacy import.
- `SULLA_PROJECTS_AUTO_ARCHIVE_HOURS` — archive threshold; `0` disables the service timer.
- Server mode additionally requires `SULLA_PROJECTS_JWT_ISSUER`, `SULLA_PROJECTS_JWT_AUDIENCE`, and either `SULLA_PROJECTS_JWT_SECRET` or `SULLA_PROJECTS_JWT_PUBLIC_KEY`.

The local and human token files and runtime database password are provisioned by Desktop lifecycle code with mode `0600`. Tokens are never database credentials.

## Narrow verification

Run the standalone compile without traversing the Desktop graph:

```sh
~/sulla/bin/sulla-heavy ./node_modules/.bin/tsc -p services/sulla-projects/tsconfig.json --noEmit
```

Run the isolated synthetic container acceptance (never points at a live database):

```sh
bash services/sulla-projects/scripts/synthetic-smoke.sh
```

The script uses `/usr/bin/docker -H unix:///var/run/docker.sock`, builds `sulla-projects-synthetic:local`, and verifies Desktop capabilities/outbox, server RBAC and RLS, atomic mutation rollback, inherited claim handoff, legacy import verification, persistent legacy write fencing, and restart recovery. It removes only its uniquely named `sulla-projects-acceptance-*` fixtures on exit.

The legacy fence is reversible in code through `removeLegacyProjectsWriteFence(connectionString)`. It removes only the named fence triggers/function and leaves every legacy row intact.
