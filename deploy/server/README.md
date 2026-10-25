# Sulla server install kit

## One-line install

On a prepared Ubuntu 24.04 LTS server:

```bash
npx sulla-desktop server
```

The npm launcher ships the deployment kit, pins new installations to a source commit with a published matching server image, and requests root access through `sudo` when needed. It keeps the terminal attached while the installer asks for Docker Compose or Kubernetes, public URL, Vault hostname (default `vault.<host>`), TLS or ingress settings, storage, and the owner's email, display name and organization.

### First run

The installer then asks for two passwords, each twice with terminal echo off:

1. **Sign-in password.** Accounts creates the organization, the owner's Keycloak user, an owner/admin membership and the `server-admin` realm role (`POST /v1/admin/setup/first-owner`).
2. **Vault unlock password.** It must differ from the sign-in password. The Vault CLI derives the keys inside the vault container and creates the Vault owner in the Accounts organization's id, so both services share one organization.

Passwords stay in unexported shell variables and reach the containers only on stdin. They are never put in command arguments, `server.env`, logs or shell history.

The server id is created once and kept in `${SULLA_DATA_DIR}/server-id` (`/opt/sulla/server/server-id` on Kubernetes). Progress markers live in `${SULLA_DATA_DIR}/install/`. Rerunning the installer prints `kept` for the owner, organization, Vault and server id and changes none of them. If a run is interrupted, rerun it: it asks only for the passwords of the steps that did not finish, and reports a step as kept when the service shows it already completed.

When it finishes, open `<public URL>/console` and sign in as the owner. The console asks for a license key. The console verifies license keys with `SULLA_SERVER_LICENSE_PUBLIC_KEY`; pass it to the installer or add it to `server.env`.

### Hostname and certificates (Compose)

```bash
sudo bash install.sh --hostname sulla.example.com --cloudflare-token-file /root/cloudflare-dns.token
```

`--hostname` serves the console at `https://<hostname>` and Passwords at `https://vault.<hostname>`, with one certificate covering both names. Point both names at the server (an A record may use a LAN address).

- **With `--cloudflare-token-file`**, the installer gets a Let's Encrypt certificate through the DNS-01 challenge, so a LAN-only server works. The file must hold a Cloudflare API token scoped to Zone:DNS:Edit and must be mode `0600`. The installer copies it to `secrets/cloudflare-dns.token` and hands it to [lego](https://go-acme.github.io/lego/) only as a mounted file; it is never printed or put in an environment value. The `tls-renew` service renews the certificate 30 days before it expires, and the gateway reloads certificates every 6 hours.
- **Without a token**, the installer creates a local CA in `${SULLA_DATA_DIR}/tls-ca/` and signs a 397-day certificate for both names. Trust `${SULLA_DATA_DIR}/tls-ca/public/ca.crt` on every computer that opens the console. Reruns renew the certificate when it has less than 30 days left. Rerun later with `--cloudflare-token-file` to switch to Let's Encrypt.

The hostname is saved in `${SULLA_DATA_DIR}/hostname`. A rerun keeps it and refuses a different `--hostname`.

Compose installs run under the project name you choose (default `sulla-server`), so a second test install on the same host can use its own name, data directory and port. If `compose.override.yaml` exists next to `compose.yaml`, the installer includes it.

The Docker socket proxy (`docker-socket-proxy:2375`) lets the console read container status, logs and stats and start the `backup` container. Every other Docker API call gets 403.

To add a Kubernetes worker later, pass only the server URL:

```bash
K3S_URL=https://FIRST_SERVER_IP:6443 npx sulla-desktop server
```

The join token is requested through a hidden terminal prompt after elevation. The kit and root-readable `server.env` are saved to `/opt/sulla/server`; rerunning the installer keeps the database, generated service secrets, owner, organization, Vault and server id.

The direct `curl | sudo bash` entry point remains available for source checkouts and recovery:

```bash
curl -fsSL https://raw.githubusercontent.com/merchantprotocol/sulla-desktop/main/deploy/server/install.sh | sudo bash
```

For a checked-out commit inside the native Sulla VM, start with this server kit rather than the repository's Desktop development Compose file:

```bash
sudo SULLA_BUNDLE_DIR="$PWD/deploy/server" \
  SULLA_BUNDLE_SOURCE_SHA="$(git rev-parse HEAD)" \
  SULLA_SOURCE_SHA="$(git rev-parse HEAD)" \
  bash deploy/server/install.sh
```

Compose asks explicitly whether the console shell is `standalone` or `native-lima`. The standalone choice runs the console container and remains the default for ordinary servers. Inside Sulla Desktop's Lima VM, `native-lima` reuses the persistent listener that Desktop already installs at `host.docker.internal:30121`; that listener runs as the unprivileged `sulla-console` user, and Compose does not start a second console container. The server kit does not install this listener. It refuses `native-lima` when the bundled OpenRC service is absent, starts that service when needed, waits at most 30 seconds for its health endpoint, and proves a Docker bridge container can reach it before rolling out the server stack.

The installer writes the real server configuration to `/opt/sulla/server/server.env` and invokes `/opt/sulla/server/compose.yaml`. To restart that generated installation directly in the VM:

```bash
sudo bash -c 'set -a; . /opt/sulla/server/server.env; set +a; exec /usr/bin/docker -H unix:///run/docker.sock compose --env-file /dev/null -f /opt/sulla/server/compose.yaml up -d --remove-orphans'
```

The repository's root Desktop Compose remains a desktop-mode development runtime. Installing a native shell or setting initial source-directory/port variables does not switch domain services into server mode; the server kit's generated environment and Compose file do that explicitly.

Compose builds the six server services (Accounts/Keycloak, Vault, Files, Agents, Workflows, and Tools), the agent runner image, and, in standalone mode, the independent console from the exact resolved source commit. Kubernetes defaults to CI-published `sha-<12 characters>` images for that commit and proves their manifests are available before changing the cluster. A custom pinned image tag or digest is also accepted and its pull is verified by the rollout. Agents and Workflows receive private Accounts service credentials, isolated databases, Redis, the Docker runtime socket, and configured runner images. They also share a separate generated service-token file for their private workload API: Workflows reaches Agents at `http://agents:8789` under Compose (`http://sulla-agents:8789` in Kubernetes), and Agents receives the same secret as `SULLA_WORKFLOWS_SERVICE_TOKEN_FILE`. This token is never reused as an Accounts token or as the installation API token.

The gateway exposes only Accounts `/v1/web`, the Sulla Keycloak realm/resources, each service's `/ui` and public API prefix, and the console. Accounts private/admin/bootstrap paths remain internal. Files' public API is deliberately `/services/files/api/v1/...` and maps to the service's `/v1/...` without adding a second `v1`. The public Accounts/Keycloak origin must be the real external HTTPS origin in server deployments; do not configure a container-local `localhost` URL. Vault, Files, Agents, and Workflows resolve browser sessions through Accounts with distinct service credentials. The generated Accounts token map uses the service IDs `accounts`, `vault`, `files`, `agents`, and `workflows`.

Tools derives the same capability-signing key as Agents and Workflows from the generated installation API token. A Desktop executor is optional: leave both `SULLA_DESKTOP_EXECUTOR_URL` and `SULLA_DESKTOP_EXECUTOR_TOKEN` blank to run the local catalog without host fallback, or configure both together (with a token of at least 32 characters). Tools executes the `files`, `pg`, `redis`, and `project` catalog categories in the server process. Every other target requires a configured executor today: controller operations (the `agents` category and agent-control operations), workflow-manager operations, agent-local filesystem/workspace/exec and Git operations, and all remaining desktop-local categories such as browser, calendar, Docker, Kubernetes, notifications, settings, integrations, and host-app automation. Without an executor those targets fail closed as unconfigured; the kit never invents a host endpoint.

The gateway derives `X-Forwarded-Proto` from the configured public URL and ignores any client-supplied forwarding scheme. If TLS terminates at an ingress or reverse proxy, keep `SULLA_PUBLIC_URL` set to the browser-visible `https://` origin.

The service images and runner images are separate contracts. Compose builds the agent runner locally and records its exact tag in `server.env`; Kubernetes requires an explicitly pinned runner image. The generated Docker network name is passed to both managers instead of assuming a Compose project name. Provider-backed agent execution additionally requires private OpenAI or Anthropic key files configured for the Agents service. The current Workflows image must propagate its server runner environment before runner containers can execute, and workflow nodes that launch agents additionally require its server agent launcher. These are workload-image dependencies, not values the deployment kit can replace with manifest placeholders.

Sulla Desktop's built-in k3s runs **inside a Lima virtual machine**. Other physical machines cannot join that private cluster as nodes. A multi-server cluster therefore needs k3s installed natively on Ubuntu, which is what these scripts do.

## What you need

- One Ubuntu 24.04 LTS server with at least 4 CPU cores, 8 GB RAM, and 50 GB free disk for the first node.
- Optional additional Ubuntu 24.04 LTS servers. Each needs a unique hostname.
- All nodes on the same trusted LAN, with stable IP addresses. A DHCP reservation in the router is usually simpler and safer than hand-editing Netplan.
- Internet access while installing k3s and pulling container images.
- This `deploy/server` directory copied to the first server.

The Compose choice runs on Ubuntu 20.04 LTS or newer and requires Docker Engine with the Compose v2 plugin already installed and running. The wizard checks both, but it does not install Docker. The Kubernetes `existing` choice requires a working `kubectl` context. The Kubernetes `install` choice installs k3s only on a native Ubuntu 24.04 LTS server with systemd.

The scripts pin k3s to `v1.36.4+k3s1`. Override it only deliberately by exporting `INSTALL_K3S_VERSION` before running either install script.

## 1. Prepare every server

Choose a unique name and make its IP stable. On each server:

```bash
sudo hostnamectl set-hostname sulla-01  # use sulla-02, sulla-03, etc. on other nodes
sudo apt-get update
sudo apt-get full-upgrade -y
sudo apt-get install -y curl openssl ca-certificates
sudo reboot
```

After reboot, confirm the hostname and address:

```bash
hostnamectl --static
ip -4 address
```

If UFW is active, keep SSH open and allow k3s traffic from your LAN. Replace `192.168.1.0/24` with the actual trusted server subnet:

```bash
sudo ufw allow OpenSSH
sudo ufw allow from 192.168.1.0/24 to any port 8472 proto udp comment 'k3s flannel VXLAN'
sudo ufw allow from 192.168.1.0/24 to any port 10250 proto tcp comment 'k3s kubelet metrics'
```

On the first/server node, also allow the Kubernetes API:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 6443 proto tcp comment 'k3s API'
```

Ports `2379-2380/tcp` are **not** needed for the single-server setup in this guide. Open them only between k3s server nodes if you later build an HA cluster with embedded etcd. Do not expose any of these ports to the public internet.

## 2. Choose or install the Kubernetes cluster

The wizard keeps these paths separate. Choose `existing` to deploy through the current `kubectl` context without installing, upgrading, or reconfiguring Kubernetes. Choose `install` only on a fresh Ubuntu server where the wizard should install the pinned k3s release.

### Install a new first k3s server

From this directory on the first server, pass its stable LAN IP:

```bash
chmod +x install-server.sh join-node.sh deploy-sulla.sh
sudo ./install-server.sh 192.168.1.10
```

The script is safe to run again. It checks Ubuntu and root access, installs the pinned k3s release, enables the service, and gives the IP to the k3s certificate.

Verify the first node:

```bash
sudo kubectl get nodes -o wide
```

It should report `Ready`. When adding a worker, keep the token out of output and shell history:

```bash
read -rsp 'Node token: ' K3S_TOKEN </dev/tty; echo
sudo K3S_TOKEN="$K3S_TOKEN" ./join-node.sh https://192.168.1.10:6443
unset K3S_TOKEN
```

Treat that token like a password. Do not paste it into tickets, chat, logs, or a committed file.

## 3. Join additional servers

Copy this directory to each additional server. Use an environment variable to keep the token out of shell history:

```bash
read -rsp 'Node token: ' K3S_TOKEN; echo
sudo K3S_TOKEN="$K3S_TOKEN" ./join-node.sh https://192.168.1.10:6443
unset K3S_TOKEN
```

`join-node.sh` also accepts `SERVER_URL TOKEN` as two arguments, or `K3S_URL` and `K3S_TOKEN` as environment variables. It never prints the token. The script is idempotent and can be rerun to repair the agent service or apply the pinned k3s version.

Back on the first server, wait until every node is `Ready`:

```bash
sudo kubectl get nodes -o wide --watch
```

Press Ctrl+C after all nodes are ready.

## 4. Deploy Sulla's backing services

On the first server:

```bash
sudo ./deploy-sulla.sh
```

The installer generates PostgreSQL, Vault JWT, bootstrap, Accounts service, shared capability, and executor secrets once and saves them in `server.env` with mode `0600`. The deploy script applies those values through a Kubernetes Secret, renders the selected storage and pinned image settings, waits for every Deployment, and prints the final Pods, PVCs, and Services. For an existing cluster, the selected context is flattened into a root-readable task kubeconfig and used explicitly on every call. Rerunning it preserves the same cluster target, secrets, and database volume. If an unrelated `sulla` namespace already exists, deployment stops before changing its Secrets or PVCs.

Existing installs may drop the retired `sulla_projects` database manually after exporting any data they need; upgrades never drop it automatically.

PostgreSQL stays `ClusterIP`. The wizard can create an Ingress or leave routing to an existing ingress. It prints the real console login URL only after rollout and first-owner bootstrap succeed.

The PostgreSQL volume uses the storage class and size selected in the wizard. With k3s's default `local-path`, the volume has node affinity and is not replicated. Back up PostgreSQL before relying on it for irreplaceable data.

Useful checks:

```bash
sudo kubectl -n sulla get pods,pvc,services -o wide
sudo kubectl -n sulla get events --sort-by=.lastTimestamp
sudo kubectl -n sulla logs deployment/postgres --tail=100
sudo kubectl -n sulla logs deployment/sulla-vault --tail=100
```

## Troubleshooting

### A node stays `NotReady`

On the affected machine:

```bash
sudo systemctl status k3s-agent --no-pager
sudo journalctl -u k3s-agent -n 200 --no-pager
```

Confirm its clock is correct (`timedatectl`), its hostname is unique, it can reach `https://FIRST_SERVER_IP:6443`, and TCP 10250 plus UDP 8472 are allowed between nodes. A wrong or rotated token is fixed by rerunning `join-node.sh` with the current token.

### The server service will not start

```bash
sudo systemctl status k3s --no-pager
sudo journalctl -u k3s -n 200 --no-pager
sudo ss -lntup | grep -E ':(6443|8472|10250)\b'
```

Look for an IP/hostname mismatch, another process using a required port, or a firewall rule blocking node-to-node traffic.

### A Pod is `Pending`

```bash
sudo kubectl -n sulla describe pod POD_NAME
sudo kubectl -n sulla get pvc,pv -o wide
```

If the event mentions volume node affinity, the PVC was created on a node that is unavailable. Bring that node back before moving data; deleting a local-path PVC can delete its data.

### A Pod is restarting or failing its health check

```bash
sudo kubectl -n sulla logs POD_NAME --previous --tail=200
sudo kubectl -n sulla describe pod POD_NAME
```

Image pull failures usually mean GHCR or Docker Hub cannot be reached. Runtime health failures can also mean an incompatible `:latest` runtime image was published; inspect the image ID with `kubectl -n sulla describe pod POD_NAME`.

### `kubectl` says permission denied

Use `sudo kubectl ...` on the first server. k3s stores its admin kubeconfig at `/etc/rancher/k3s/k3s.yaml` with restricted permissions.

## Undo

### Files envelope-key custody

The installer persists a distinct `SULLA_FILES_MASTER_KEY` in the root-readable
`server.env` and supplies it to Files through Compose or the `files-master-key`
entry of the managed Kubernetes Secret. Reruns preserve this key. An installation
created before envelope encryption receives a key once, before the service wraps
its historical collection keys. Do not rotate the Files master by changing the
environment variable; use a supported recovery or rewrapping procedure.

Keep a secure backup of `server.env` separate from Files ciphertext backups.
Restoring a database and chunks requires the matching Files master as well.
Additional replicas of the same Files database must use that same key. The
installer refuses a missing master after it has recorded envelope provisioning;
restore the saved key rather than deleting the marker or key-state rows.

Take a coordinated database/chunk/configuration recovery point before upgrading
an existing server. Older signing-derived-key code cannot read newly created
random-key collections. After new writes, rollback requires restoring that
coordinated recovery point, with the resulting loss of later writes, or applying
a forward fix. Reverting only the image is not a safe data rollback.

Remove Sulla workloads while leaving k3s installed:

```bash
sudo kubectl delete namespace sulla
```

That also deletes the local-path PVCs and their data. Export or back up anything important first.

Remove an agent node by running this on that agent:

```bash
sudo /usr/local/bin/k3s-agent-uninstall.sh
```

Then remove its stale node record on the first server if it remains:

```bash
sudo kubectl delete node NODE_NAME
```

Remove the first/server node and its entire local cluster:

```bash
sudo /usr/local/bin/k3s-uninstall.sh
```

The uninstall scripts remove k3s containers, cluster state, and local storage managed by that installation. Back up Sulla data first.

## Server license trust key

The console verifies Sulla Cloud license tokens offline. `SULLA_SERVER_LICENSE_PUBLIC_KEY` must contain the base64 DER/SPKI Ed25519 public key that matches the Cloud Worker `SERVER_LICENSE_SIGNING_KEY` secret. The private key never belongs on the server. Compose persists the activated token in `${SULLA_DATA_DIR}/console/license.json` with container mode `0600`; Kubernetes reads the public key from the `sulla-license` Secret and stores activation state in `sulla-console-license`.

Use Cases clients must call `GET /license/catalog-access` before loading or installing catalog entries. It returns `403 license_required` for missing, invalid, expired, revoked-on-check-in, or over-seat licenses. License status is exposed as `GET /license`. Until the authenticated Console API owns activation, `POST /license/activate` (`{"licenseKey":"…"}`) accepts loopback requests only.
