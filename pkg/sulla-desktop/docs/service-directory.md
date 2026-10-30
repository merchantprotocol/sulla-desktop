# Local service directory

`main/serviceDirectory.ts` is the single source of truth for ports exposed on
the Mac. Docker services publish an ephemeral port on the guest loopback. The
runtime forwarder follows Docker's event stream, reads the actual published
port from `/containers/json`, and forwards the sticky Mac-side port stored in
`appHome/ports.json`. The file is replaced atomically and is deliberately not
stored in the vault, so first-run startup never waits for vault availability.
An atomic `appHome/ports.env` projection is regenerated with every change for
shell consumers that cannot call the catalog.

Main-process callers use `servicePort`, `serviceOrigin`, and
`onServiceChange`. Renderers use `services:where`, `services:list`, and the
`services:changed` push event. Agents and scripts use `sulla services/where`
and `sulla services/list`. Containers use Docker DNS names and container ports;
they do not call back through published host ports.

## Compatibility boundaries

- **Vault HTTPS:** the certificate is issued for loopback IP identity, not a
  port. The sticky port preserves its normal origin. If a real conflict forces
  reassignment, the compose environment receives the resolved origin before
  the vault starts and Electron's pinned session is recreated by the existing
  vault TLS lifecycle. Cookies belong to the new origin and are intentionally
  not copied from the old one.
- **Persisted URLs:** settings, integrations, recipes, and extensions may hold
  user-entered external URLs. The directory changes only built-in local
  defaults; it must never rewrite an explicitly persisted URL. Built-in local
  callers resolve on each process launch and subscribe where they are long
  lived.
- **Mobile and Cloud relay:** relay transport discovers the local relay through
  the directory. Cloud-facing URLs remain Cloud URLs; no VM guest port is
  exposed as a remote contract.
- **First-run test instance:** PR #1743's numeric offset is intentionally not a
  dependency. Once this lands, that instance should use its own appHome and
  therefore its own `ports.json`.

The phase-two name-based HTTP gateway described in the project plan is not
implemented here. `serviceOrigin` is the seam: a gateway can change origin
construction later without changing callers or Docker discovery.
