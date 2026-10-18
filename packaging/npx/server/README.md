# Sulla server install kit

## One-line install

On a prepared Ubuntu 24.04 LTS server:

```bash
npx sulla-desktop server
```

The npm launcher ships the deployment kit, pins new installations to a source commit with a published matching server image, and requests root access through `sudo` when needed. It keeps the terminal attached while the installer asks for Docker Compose or Kubernetes, public URL, TLS or ingress settings, storage, organization, and first owner details. The owner password is entered twice with terminal echo disabled and derived inside the vault container; plaintext is never sent to the service, printed, stored, or placed in command arguments.

To add a Kubernetes worker later, pass only the server URL:

```bash
K3S_URL=https://FIRST_SERVER_IP:6443 npx sulla-desktop server
```

The join token is requested through a hidden terminal prompt after elevation. The kit and root-readable `server.env` are saved to `/opt/sulla/server`; rerunning the installer keeps the database, generated service secrets, first owner, and organization.

The direct `curl | sudo bash` entry point remains available for source checkouts and recovery:

```bash
curl -fsSL https://raw.githubusercontent.com/merchantprotocol/sulla-desktop/main/deploy/server/install.sh | sudo bash
```

Compose builds the Vault, Files, and Projects images from the exact resolved source commit. Kubernetes defaults to CI-published `sha-<12 characters>` images for that commit and proves their manifests are available before changing the cluster. A custom pinned image tag or digest is also accepted and its pull is verified by the rollout. Agent and workflow runtime wiring remains outside this server-console kit.

Sulla Desktop's built-in k3s runs **inside a Lima virtual machine**. Other physical machines cannot join that private cluster as nodes. A multi-server cluster therefore needs k3s installed natively on Ubuntu, which is what these scripts do.

## What you need

- One Ubuntu 24.04 LTS server with at least 4 CPU cores, 8 GB RAM, and 50 GB free disk for the first node.
- Optional additional Ubuntu 24.04 LTS servers. Each needs a unique hostname.
- All nodes on the same trusted LAN, with stable IP addresses. A DHCP reservation in the router is usually simpler and safer than hand-editing Netplan.
- Internet access while installing k3s and pulling container images.
- This `deploy/server` directory copied to the first server.

The Compose choice requires Docker Engine with the Compose v2 plugin already installed and running. The wizard checks both, but it does not install Docker. The Kubernetes `existing` choice requires a working `kubectl` context. The Kubernetes `install` choice installs k3s only on a native Ubuntu 24.04 LTS server with systemd.

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

The installer generates PostgreSQL, JWT, bootstrap, and Projects runtime-role secrets once and saves them in `server.env` with mode `0600`. Projects creates its isolated `sulla_projects` database and runs migrations as the `sulla` owner, while requests use the non-superuser, non-`BYPASSRLS` `sulla_projects_service` role. The deploy script applies those values through a Kubernetes Secret, renders the selected storage and pinned image settings, waits for every Deployment, and prints the final Pods, PVCs, and Services. For an existing cluster, the selected context is flattened into a root-readable task kubeconfig and used explicitly on every call. Rerunning it preserves the same cluster target, secrets, and database volume. If an unrelated `sulla` namespace already exists, deployment stops before changing its Secrets or PVCs.

Projects is routed at `/projects-api/v1/`; other `/projects-api/` paths, including the container health endpoint, are not exposed. Server requests require a bearer JWT signed with `SULLA_PROJECTS_JWT_SECRET`, issuer `sulla-server`, audience `sulla-projects`, a subject and expiry, an `org_id` or `tenant_id`, and an optional `projects_role` of `viewer`, `editor`, or `admin` (default `viewer`). The install kit configures verification but does not mint user tokens; the server identity layer must issue those claims before external clients can use the API. Keep the signing secret in `server.env` or the Kubernetes Secret, never in client configuration.

PostgreSQL stays `ClusterIP`. The wizard can create an Ingress or leave routing to an existing ingress. It prints the real console login URL only after rollout and first-owner bootstrap succeed.

The PostgreSQL volume uses the storage class and size selected in the wizard. With k3s's default `local-path`, the volume has node affinity and is not replicated. Back up PostgreSQL before relying on it for irreplaceable data.

Useful checks:

```bash
sudo kubectl -n sulla get pods,pvc,services -o wide
sudo kubectl -n sulla get events --sort-by=.lastTimestamp
sudo kubectl -n sulla logs deployment/postgres --tail=100
sudo kubectl -n sulla logs deployment/sulla-vault --tail=100
sudo kubectl -n sulla logs deployment/sulla-projects --tail=100
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
