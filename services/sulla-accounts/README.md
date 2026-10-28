# Sulla Accounts core

GPL-2.0-or-later Accounts core for Desktop's local, single-user identity broker. The image defaults to and accepts only `SULLA_ACCOUNTS_MODE=desktop`; its local bootstrap, owner sessions, remote OIDC connections, service grants, database schema `001`–`005`, ports, secret paths, and API behavior are unchanged.

## Adapter API

`src/adapter.ts` defines Accounts adapter API v1. A derived product can register routes before the core Desktop routes, but must reject incompatible API versions. Sulla Server's separately licensed adapter and migrations live in `merchantprotocol/sulla-server` and its derived image is `ghcr.io/merchantprotocol/sulla-server-accounts`.

The Desktop base image contains no Keycloak distribution/theme, hosted web/admin/device routes, Server bootstrap CLI, entitlement verifier, seat allocator, or Server migrations.
