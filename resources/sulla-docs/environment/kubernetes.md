# Kubernetes (k3s) & rdctl

Sulla Desktop is built on Rancher Desktop, which ships with **k3s** — a lightweight Kubernetes distribution running inside the Lima VM. k3s is **enabled by default**, the kubeconfig at `~/.kube/config` is auto-symlinked, and the agent has tools to drive it.

## Why this matters

k3s is not just available — it's **actively used by Sulla Desktop itself**:

- The backend manages the cluster lifecycle (start/stop/restart)
- Manifests are deployed to k3s for cert-manager, SpinKube operator (Wasm workloads), and Traefik ingress
- The Rancher Dashboard runs in k3s

So when a user asks "what's running in my cluster," there's likely Sulla-managed infrastructure mixed with whatever they've deployed.

## Tools

### `kubectl/*`

| Tool | Purpose |
|------|---------|
| `sulla kubectl/kubectl_apply` | Apply a manifest. Supports `namespace`, `dryRun: 'client'\|'server'\|'none'` |
| `sulla kubectl/kubectl_delete` | Delete by type+name. Supports `force`, `gracePeriod`, `namespace` |
| `sulla kubectl/kubectl_describe` | Show full details of a resource |

**There is no built-in `kubectl_get` or `kubectl_logs` tool.** Workarounds:
- For `get`: use `rdctl_shell 'kubectl get pods -A'`
- For `logs`: `rdctl_shell 'kubectl logs -n <ns> <pod>'`

### `rdctl/*`

Rancher Desktop CLI, exposed as agent tools:

| Tool | Purpose |
|------|---------|
| `sulla rdctl/rdctl_info` | Sulla Desktop version, runtime, enabled features |
| `sulla rdctl/rdctl_list_settings` | Show all current configuration |
| `sulla rdctl/rdctl_set` | Update a setting and restart the backend |
| `sulla rdctl/rdctl_shell` | Run any shell command inside the Sulla VM |
| `sulla rdctl/rdctl_extension` | Install / uninstall / list extensions (lower-level than `extensions/*`) |
| `sulla rdctl/rdctl_snapshot` | List / create / delete VM snapshots |
| `sulla rdctl/rdctl_start` | Start the backend |
| `sulla rdctl/rdctl_shutdown` | Shut down the backend |
| `sulla rdctl/rdctl_reset` | Reset the cluster to factory defaults — **destructive, confirm with user** |
| `sulla rdctl/rdctl_version` | rdctl version |

All run via `runCommand()` (60s default timeout, 160KB output cap).

## Common requests

### "What's running in my cluster?"
```bash
sulla rdctl/rdctl_shell '{"command":"kubectl get pods -A"}'
```
Or for a specific namespace:
```bash
sulla rdctl/rdctl_shell '{"command":"kubectl get pods -n default"}'
```

### "Show me logs from pod X"
```bash
sulla rdctl/rdctl_shell '{"command":"kubectl logs -n default my-pod --tail=200"}'
```

### "Deploy this manifest"
```bash
sulla kubectl/kubectl_apply '{"file":"/path/to/manifest.yaml","namespace":"default"}'
```
**Always offer `dryRun: 'server'` first** for unfamiliar manifests so the user can preview the diff.

### "Why is my service broken?"
```bash
sulla kubectl/kubectl_describe '{"resource":"service","name":"my-service","namespace":"default"}'
```
Reads events, endpoints, selector, port mappings. Then:
```bash
sulla rdctl/rdctl_shell '{"command":"kubectl get endpoints my-service -n default -o yaml"}'
```

### "Delete this pod"
```bash
sulla kubectl/kubectl_delete '{"resource":"pod","name":"stuck-pod","namespace":"default"}'
```
**Always confirm** before passing `force: true` or `gracePeriod: 0`.

### "Scale my deployment"
No dedicated scale tool. Workaround:
```bash
sulla rdctl/rdctl_shell '{"command":"kubectl scale deployment/my-app --replicas=3 -n default"}'
```

### "Reset Kubernetes"
```bash
sulla rdctl/rdctl_reset '{}'
```
**Destructive — confirm with user. Wipes the cluster.**

## Safety rails — there are none

This is the most important section. **The agent has full root over the user's k8s cluster.** Specifically:

- `kubectl_delete` accepts `force: true` and `gracePeriod: 0` and passes them straight through
- `kubectl_apply` defaults to live apply (no dry-run) if you don't specify
- `rdctl_shell` runs **arbitrary commands** inside the VM
- `rdctl_set` can change any backend setting and trigger a restart
- `rdctl_reset` wipes the cluster

There are **no guardrails for system namespaces** (`kube-system`, `kube-node-lease`, `kube-public`). You can `kubectl delete -A` and remove core Kubernetes components. Don't.

### Discipline you must apply

1. **Default to `dryRun: 'server'`** for `kubectl_apply` of unfamiliar manifests — show the diff, ask the user to confirm
2. **Refuse to touch `kube-system` / `kube-public` / `kube-node-lease`** without explicit, repeated user confirmation
3. **Refuse to touch anything in the Sulla-managed namespaces** (cert-manager, spinkube, traefik) without explicit user confirmation — you'll break the desktop app
4. **For `rdctl_reset`:** treat as `rm -rf /` for the cluster. Triple-confirm.
5. **For `kubectl_delete`:** show what will be deleted (a `kubectl_describe` first), then confirm
6. **For `rdctl_shell`:** if the command is destructive (rm, kill, dd, mkfs, partprobe), confirm. If it's interactive (passes a `-i` flag), it will hang.

## What the agent does NOT have

- No `kubectl_get` tool — workaround via `rdctl_shell`
- No `kubectl_logs` tool — workaround via `rdctl_shell`
- No `kubectl_exec` tool — use `rdctl_shell 'kubectl exec ...'`
- No `kubectl_port-forward` tool
- No streaming log tool — `rdctl_shell 'kubectl logs -f'` will hit the 60s timeout
- No `helm` integration

## Reference

- kubectl tools: `pkg/rancher-desktop/agent/tools/kubectl/`
- rdctl tools: `pkg/rancher-desktop/agent/tools/rdctl/`
- k3s install script: `pkg/rancher-desktop/assets/scripts/install-k3s`
- kubeconfig symlink: `pkg/rancher-desktop/main/diagnostics/kubeConfigSymlink.ts`
- Cluster lifecycle: `pkg/rancher-desktop/backend/k3sHelper.ts`
- Command runner: `pkg/rancher-desktop/agent/tools/util/CommandRunner.ts`
