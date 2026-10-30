# Local service directory

`main/serviceDirectory.ts` is the single source of truth for ports exposed on
the Mac. Docker services publish an ephemeral port on the guest loopback. The
runtime forwarder follows Docker's event stream, reads the actual published
port from `/containers/json`, and forwards the sticky Mac-side port stored in
`appHome/ports.json`. The file is replaced atomically and is deliberately not
stored in the vault, so first-run startup never waits for vault availability.
An atomic `appHome/ports.env` projection is regenerated with every change for
shell consumers that cannot call the catalog.

## Instance namespace

`SULLA_INSTANCE_NAMESPACE` is the one instance identity (default: `sulla`). A
value such as `sulla-firstrun-test` changes, as one unit:

- the Compose project, generated Compose file, container prefixes, default
  network, and Compose-owned volume prefixes;
- Desktop application/config/cache/log/Sulla paths, including that instance's
  own `appHome/ports.json` and `ports.env`; and
- the deterministic sticky-port lane used before conflict reassignment.

Compose service keys do not change, so containers still address one another as
`postgres:5432`, `redis:6379`, `sulla_vault:8787`, and so on inside their own
namespace network. A first-run test is therefore the same code with only
`SULLA_INSTANCE_NAMESPACE=sulla-firstrun-test` (plus its separate runtime dir
when it uses a separate VM), not a numeric port-offset fork.

When `SULLA_RUNTIME_DIR` points at another VM, that VM already has its own
Docker daemon. Namespace isolation still matters for Mac-side paths and ports,
and keeps the design safe if test and production ever share one VM.

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
  dependency. It should set only its namespace and runtime directory; the
  namespace supplies its app paths, `ports.json`, Compose resources and ports.

The phase-two name-based HTTP gateway described in the project plan is not
implemented here. `serviceOrigin` is the seam: a gateway can change origin
construction later without changing callers or Docker discovery.
