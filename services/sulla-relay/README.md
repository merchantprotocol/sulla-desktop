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

`compose.verify.yaml` starts Redis, two relay replicas, and a headless client built from the same `RelayToolTunnel` used by Electron. The harness connects to replica 1 and calls replica 2, then verifies offline, cross-user, and deadline-cancellation behavior.
