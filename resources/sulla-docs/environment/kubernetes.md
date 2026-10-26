# Kubernetes (k3s)

Sulla Desktop ships with **k3s** — a lightweight Kubernetes distribution running inside the Sulla VM. k3s is **enabled by default**, the kubeconfig at `~/.kube/config` is auto-symlinked, and the agent has tools to drive it.

## Why this matters

k3s is not just available — it's **actively used by Sulla Desktop itself**:

- The backend manages the cluster lifecycle (start/stop/restart)
- Cluster components depend on settings; SpinKube is optional and defaults to disabled (`config/settings.ts`)

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
Docker/kubectl wrappers use CommandRunner; an active agent-container
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

## Cluster mutation risks

The wrappers do not implement namespace-specific protection. Actual authority depends on the selected kubeconfig credentials. Specifically:

- `kubectl_delete` accepts `force: true` and `gracePeriod: 0` and passes them straight through
- `kubectl_apply` defaults to live apply (no dry-run) if you don't specify

There are **no guardrails for system namespaces** (`kube-system`, `kube-node-lease`, `kube-public`). You can `kubectl delete -A` and remove core Kubernetes components. Don't.

### Discipline

Check context, namespace and resource identity before changing a cluster.
Confirm actions that could harm Kubernetes or Sulla's core services. Use
server dry-run for unfamiliar manifests and preserve recovery options before
resetting a cluster. Do not assume optional components are Sulla-managed just
because a namespace has a familiar name. Streaming commands need bounded
execution; `kubectl` tools use a 60-second timeout and 160,000-character cap.
backend. No Helm tool is registered in these categories.

## Reference

- kubectl tools: `pkg/sulla-desktop/agent/tools/kubectl/`
- k3s install script: `pkg/sulla-desktop/assets/scripts/install-k3s`
- Cluster lifecycle: `pkg/sulla-desktop/backend/k3sHelper.ts`
- Command runner: `pkg/sulla-desktop/agent/tools/util/CommandRunner.ts`
