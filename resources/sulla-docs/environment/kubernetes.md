# Kubernetes (k3s) & rdctl

Sulla Desktop is built on Rancher Desktop, which ships with **k3s** — a lightweight Kubernetes distribution running inside the Sulla VM. k3s is **enabled by default**, the kubeconfig at `~/.kube/config` is auto-symlinked, and the agent has tools to drive it.

## Why this matters

k3s is not just available — it's **actively used by Sulla Desktop itself**:

- The backend manages the cluster lifecycle (start/stop/restart)
- Cluster components depend on settings; SpinKube is optional and defaults to disabled (`config/settings.ts`)
- The Rancher Dashboard runs in k3s

Check actual cluster state; availability of k3s does not prove any particular optional component is deployed.

## Tools

### `kubectl/*`

| Tool | Purpose |
|------|---------|
| `sulla kubectl/kubectl_apply` | Apply a manifest. Supports `namespace`, `dryRun: 'client'\|'server'\|'none'` |
| `sulla kubectl/kubectl_delete` | Delete by type+name. Supports `force`, `gracePeriod`, `namespace` |
| `sulla kubectl/kubectl_describe` | Show full details of a resource |

There is no built-in `kubectl_get`, `kubectl_logs`, `kubectl_exec` or
`kubectl_port-forward` tool. For read-only queries, use `meta/exec` with the
VM's `kubectl` binary and the intended kubeconfig. Verify the current context
before querying or changing resources.

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

All run via `runCommand()` with per-tool timeouts and a 160,000-character output cap.

## Common requests

### "What's running in my cluster?"

```bash
sulla meta/exec '{"command":"kubectl get pods -A"}'
```

### "Show me logs from pod X"

```bash
sulla meta/exec '{"command":"kubectl logs -n default my-pod --tail=200"}'
```

### "Deploy this manifest"

```bash
sulla kubectl/kubectl_apply '{"file":"/path/to/manifest.yaml","namespace":"default","dryRun":"server"}'
```

The file must be reachable in the tool's actual execution environment.
Docker/kubectl/rdctl wrappers use CommandRunner; an active agent-container
runtime changes where its ordinary commands execute. Server dry-run validates
a request; it is not `kubectl diff`.

### "Why is my service broken?"

```bash
sulla kubectl/kubectl_describe '{"resource":"service","name":"my-service","namespace":"default"}'
```

### "Delete this pod"

```bash
sulla kubectl/kubectl_delete '{"resource":"pod","name":"stuck-pod","namespace":"default"}'
```

Confirm risky cluster changes before executing. Inspect the resource first.

### Shell wrapper limitation

`rdctl_shell` passes `command` as a single argument after `rdctl shell --`;
it does not tokenize a whole command line or invoke a shell for it. Do not
pass examples such as `"kubectl get pods -A"` to this wrapper and expect normal
shell parsing. Use `meta/exec` for VM shell scripts. Omit interactive commands.

## Cluster mutation risks

The wrappers do not implement namespace-specific protection. Actual authority depends on the selected kubeconfig credentials. Specifically:

- `kubectl_delete` accepts `force: true` and `gracePeriod: 0` and passes them straight through
- `kubectl_apply` defaults to live apply (no dry-run) if you don't specify
- `rdctl_shell` exposes the VM command entry point, with the single-argument limitation above
- `rdctl_set` can change any backend setting and trigger a restart
- `rdctl_reset` wipes the cluster

There are **no guardrails for system namespaces** (`kube-system`, `kube-node-lease`, `kube-public`). You can `kubectl delete -A` and remove core Kubernetes components. Don't.

### Discipline

Check context, namespace and resource identity before changing a cluster.
Confirm actions that could harm Kubernetes or Sulla's core services. Use
server dry-run for unfamiliar manifests and preserve recovery options before
resetting a cluster. Do not assume optional components are Sulla-managed just
because a namespace has a familiar name. Streaming commands need bounded
execution; `kubectl` tools use a 60-second timeout and 160,000-character cap.
`rdctl_set` uses a 300-second timeout because changing settings can restart the
backend. No Helm tool is registered in these categories.

## Reference

- kubectl tools: `pkg/rancher-desktop/agent/tools/kubectl/`
- rdctl tools: `pkg/rancher-desktop/agent/tools/rdctl/`
- k3s install script: `pkg/rancher-desktop/assets/scripts/install-k3s`
- kubeconfig symlink: `pkg/rancher-desktop/main/diagnostics/kubeConfigSymlink.ts`
- Cluster lifecycle: `pkg/rancher-desktop/backend/k3sHelper.ts`
- Command runner: `pkg/rancher-desktop/agent/tools/util/CommandRunner.ts`
