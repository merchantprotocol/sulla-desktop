# Sulla server install kit

## One-line install

On a fresh Ubuntu 24.04 LTS server:

```bash
curl -fsSL https://raw.githubusercontent.com/merchantprotocol/sulla-desktop/main/deploy/server/install.sh | sudo bash
```

When it finishes, it prints the exact line to paste on each additional server so it joins the cluster. That line has this form:

```bash
curl -fsSL https://raw.githubusercontent.com/merchantprotocol/sulla-desktop/main/deploy/server/install.sh | sudo K3S_URL=https://FIRST_SERVER_IP:6443 K3S_TOKEN=<token> bash
```

The kit is saved to `/opt/sulla/server`, and rerunning the line is safe. The step-by-step version is below.

This kit turns one or more freshly installed Ubuntu 24.04 LTS servers into a native k3s cluster and deploys Sulla's PostgreSQL, Redis, and function runtimes.

Sulla Desktop's built-in k3s runs **inside a Lima virtual machine**. Other physical machines cannot join that private cluster as nodes. A multi-server cluster therefore needs k3s installed natively on Ubuntu, which is what these scripts do.

## What you need

- One Ubuntu 24.04 LTS server with at least 4 CPU cores, 8 GB RAM, and 50 GB free disk for the first node.
- Optional additional Ubuntu 24.04 LTS servers. Each needs a unique hostname.
- All nodes on the same trusted LAN, with stable IP addresses. A DHCP reservation in the router is usually simpler and safer than hand-editing Netplan.
- Internet access while installing k3s and pulling container images.
- This `deploy/server` directory copied to the first server.

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

## 2. Install the first k3s server

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

It should report `Ready`. Then retrieve the join token:

```bash
sudo cat /var/lib/rancher/k3s/server/node-token
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

The deploy script creates the `sulla` namespace, generates a random PostgreSQL password with OpenSSL if the credential Secret does not already exist, applies the Kustomize base, waits for every Deployment, and prints the final Pods, PVCs, and Services. Rerunning it preserves the existing Secret and data.

All Services are `ClusterIP`. PostgreSQL, Redis, and the runtimes are reachable only inside the cluster; this kit deliberately creates no NodePorts or public ingress.

The PostgreSQL, Redis, functions, and runtime cache volumes use k3s's `local-path` storage class. After a claim is first provisioned, its volume has node affinity and its workload stays tied to that node. This is simple and appropriate for the bridge setup, but it is not replicated storage: if that node or its disk dies, another node does not have the data. Back up PostgreSQL before relying on it for irreplaceable data.

The three runtime images currently have only the repository's existing `:latest` references. They are called out with TODO comments in `k8s/runtimes.yaml`; replace them with immutable version tags or digests when the image pipeline publishes those. PostgreSQL and Redis use verified versioned tags.

Useful checks:

```bash
sudo kubectl -n sulla get pods,pvc,services -o wide
sudo kubectl -n sulla get events --sort-by=.lastTimestamp
sudo kubectl -n sulla logs deployment/postgres --tail=100
sudo kubectl -n sulla logs deployment/redis --tail=100
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
