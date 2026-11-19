# Sulla relay

The relay carries Desktop-local tool calls from any `sulla-tools` replica to the one Desktop that owns the target device. Desktops make one outbound authenticated WebSocket connection; the relay never needs an inbound route to a Desktop.

## Identity and transport

The server join flow issues a short-lived HS256 device token with `aud: sulla-relay-device`, `sub: <user id>`, and `device_id: <device id>`. The Desktop sends it in the WebSocket `Authorization` header. Tool API replicas authenticate HTTP calls with the separate internal service token. Redis stores expiring device presence and moves calls and results between relay replicas.

Required environment:

- `SULLA_REDIS_URL`
- `SULLA_RELAY_DEVICE_TOKEN_SECRET`
- `SULLA_RELAY_INTERNAL_TOKEN`

Desktop configuration is intentionally inert unless both `SULLA_RELAY_URL` and `SULLA_RELAY_DEVICE_TOKEN` are present. `SULLA_SERVER_USER_ID` supplies the joined-server user identity; the existing signed-in user is the compatibility fallback.

## Verification

The focused runtime integration specs require `SULLA_TEST_REDIS_URL` to point to an isolated Redis 7 fixture. `RelayToolWire.spec.ts` starts two real `RelayService` HTTP listeners and the same authenticated `RelayToolTunnel` used by Electron on loopback. It verifies cross-replica dispatch, request-ID deduplication, changed-payload refusal, fingerprinted result retrieval, result retention across reconnect, offline/cross-user rejection, and presence cleanup on shutdown. `RelayRequestLedger.spec.ts` and `RelayServiceRuntime.spec.ts` cover the production Redis scripts, original lease expiry, one-time execution grants that keep a longer lease's request record for the remaining lease plus result retention without extending the lease, and heartbeat presence.

Run them with the repository's direct Vitest runner:

```sh
node node_modules/vitest/vitest.mjs run --config vitest.agent.config.mts \
  pkg/sulla-desktop/agent/tests/Feature/Runtime/RelayRequestLedger.spec.ts \
  pkg/sulla-desktop/agent/tests/Feature/Runtime/RelayServiceRuntime.spec.ts \
  pkg/sulla-desktop/agent/tests/Feature/Runtime/RelayToolWire.spec.ts
```

Without `SULLA_TEST_REDIS_URL`, the Redis integration suites are skipped. `verify/two-replica.mjs` remains a container harness for environments that provide two relay hosts named `relay1` and `relay2` and the required device/internal token environment.
