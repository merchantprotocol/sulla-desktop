#!/usr/bin/env bash
# ============================================================================
# Sulla Server — interactive CLI installer
# ============================================================================
# First server (installs k3s + Sulla services):
#   curl -fsSL https://raw.githubusercontent.com/merchantprotocol/sulla-desktop/main/deploy/server/install.sh | sudo bash
#
# Each additional server (joins the cluster as a node):
#   curl -fsSL https://raw.githubusercontent.com/merchantprotocol/sulla-desktop/main/deploy/server/install.sh | sudo K3S_URL=https://FIRST_SERVER_IP:6443 K3S_TOKEN=<token> bash
#
# The first server prints the exact join line when it finishes.
# Options (env): SULLA_REF=<branch|tag|sha> (default main), SULLA_DIR (default /opt/sulla/server)
# ============================================================================
set -euo pipefail

# Everything runs inside main() so bash reads the whole script before any
# child process can consume the piped stdin.
main() {
  SULLA_REF="${SULLA_REF:-main}"
  exec 3<>/dev/tty || { echo "A terminal is required (run this installer from an interactive shell)." >&2; exit 1; }
  log()  { printf '\033[0;32m[sulla]\033[0m %s\n' "$*"; }
  fail() { printf '\033[0;31m[sulla]\033[0m %s\n' "$*" >&2; exit 1; }
  [[ ${EUID} -eq 0 ]] || fail "run as root: curl -fsSL <url> | sudo bash"
  command -v curl >/dev/null 2>&1 || fail "curl is required: apt-get install -y curl"
  command -v openssl >/dev/null 2>&1 || fail "openssl is required"
  ask() { local var="$1" prompt="$2" default="$3" value; if [[ ${!var+x} ]]; then return; fi; printf '%s [%s]: ' "$prompt" "$default" >&3; IFS= read -r value <&3; printf -v "$var" '%s' "${value:-$default}"; }
  ask_secret() { local var="$1" prompt="$2" value; [[ -n ${!var:-} ]] && return; printf '%s: ' "$prompt" >&3; stty -echo <&3; IFS= read -r value <&3; stty echo <&3; printf '\n' >&3; printf -v "$var" '%s' "$value"; }
  valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 )); }
  parse_public_url() {
    local url="$1"
    [[ "$url" =~ ^(https?)://([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9])(:([0-9]+))?$ ]] || return 1
    SULLA_URL_SCHEME="${BASH_REMATCH[1]}"
    SULLA_URL_HOST="${BASH_REMATCH[2]}"
    SULLA_URL_PORT="${BASH_REMATCH[4]}"
    [[ -z "$SULLA_URL_PORT" ]] || valid_port "$SULLA_URL_PORT"
  }
  valid_ipv4() {
    local ip="$1" part; IFS=. read -r -a parts <<<"$ip"; [[ ${#parts[@]} -eq 4 ]] || return 1
    for part in "${parts[@]}"; do [[ "$part" =~ ^[0-9]+$ ]] && (( 10#$part <= 255 )) || return 1; done
  }
  validate_configuration() {
    [[ ${SULLA_RUNTIME:-} == compose || ${SULLA_RUNTIME:-} == kubernetes ]] || fail "runtime must be compose or kubernetes"
    parse_public_url "${SULLA_PUBLIC_URL:-}" || fail "public URL must be an http(s) origin only, with no credentials, path, query, or fragment"
    [[ -n ${SULLA_ADMIN_EMAIL:-} && "$SULLA_ADMIN_EMAIL" == *@* ]] || fail "first admin email is invalid"
    [[ -n ${SULLA_ADMIN_NAME:-} ]] || fail "first admin name is required"
    [[ -n ${SULLA_ORGANIZATION:-} ]] || fail "organization name is required"
    if [[ "$SULLA_RUNTIME" == compose ]]; then
      valid_port "${SULLA_PORT:-}" || fail "published port must be between 1 and 65535"
      valid_ipv4 "${SULLA_BIND_ADDRESS:-}" || fail "bind address must be an IPv4 address"
      [[ -n ${SULLA_DATA_DIR:-} && "$SULLA_DATA_DIR" == /* ]] || fail "persistent data directory must be an absolute path"
      [[ -z ${SULLA_TLS_CERT:-} && -z ${SULLA_TLS_KEY:-} || -n ${SULLA_TLS_CERT:-} && -n ${SULLA_TLS_KEY:-} ]] || fail "TLS certificate and private key must be supplied together"
      [[ -z ${SULLA_TLS_CERT:-} || "$SULLA_PUBLIC_URL" == https://* ]] || fail "direct TLS requires an https public URL"
      [[ -z ${SULLA_TLS_CERT:-} || -r "$SULLA_TLS_CERT" && -r "$SULLA_TLS_KEY" ]] || fail "TLS certificate or key is not readable"
    else
      [[ ${SULLA_KUBERNETES_MODE:-} == existing || ${SULLA_KUBERNETES_MODE:-} == install ]] || fail "Kubernetes cluster choice must be existing or install"
      [[ -n ${SULLA_KUBECONTEXT:-} ]] || fail "Kubernetes context is required"
      [[ -n ${SULLA_VAULT_IMAGE:-} && "$SULLA_VAULT_IMAGE" != *:latest && "$SULLA_VAULT_IMAGE" != *['| ']* ]] || fail "Kubernetes vault image must be pinned and contain no spaces"
      [[ ${SULLA_STORAGE_CLASS:-} =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || fail "storage class name is invalid"
      [[ ${SULLA_STORAGE_SIZE:-} =~ ^[1-9][0-9]*(Ei|Pi|Ti|Gi|Mi|Ki|E|P|T|G|M|K)$ ]] || fail "PostgreSQL storage size must be a Kubernetes quantity such as 20Gi"
      [[ ${SULLA_INGRESS_MODE:-} == create || ${SULLA_INGRESS_MODE:-} == existing ]] || fail "ingress must be create or existing"
      if [[ "$SULLA_INGRESS_MODE" == create ]]; then
        [[ ${SULLA_HOSTNAME:-} =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || fail "console hostname is invalid"
        [[ -z ${SULLA_TLS_SECRET:-} || ${SULLA_TLS_SECRET} =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || fail "TLS secret name is invalid"
        [[ "$SULLA_HOSTNAME" == "$SULLA_URL_HOST" ]] || fail "console hostname must match the public URL host"
        if [[ "$SULLA_URL_SCHEME" == https ]]; then
          [[ -n ${SULLA_TLS_SECRET:-} ]] || fail "an https public URL requires an ingress TLS secret"
          [[ -z "$SULLA_URL_PORT" || "$SULLA_URL_PORT" == 443 ]] || fail "created HTTPS ingress supports only the default port 443"
        else
          [[ -z ${SULLA_TLS_SECRET:-} ]] || fail "an HTTP public URL cannot use an ingress TLS secret"
          [[ -z "$SULLA_URL_PORT" || "$SULLA_URL_PORT" == 80 ]] || fail "created HTTP ingress supports only the default port 80"
        fi
      fi
    fi
  }
  verify_default_image() {
    local image="$1" repository tag token
    [[ "$image" =~ ^ghcr\.io/merchantprotocol/sulla-vault:(sha-[0-9a-f]{12})$ ]] || return 0
    repository=merchantprotocol/sulla-vault; tag="${BASH_REMATCH[1]}"
    token="$(curl -fsSL "https://ghcr.io/token?scope=repository:${repository}:pull" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
    [[ -n "$token" ]] || fail "could not authenticate an availability check for $image"
    curl -fsSL -o /dev/null -H "Authorization: Bearer $token" \
      -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
      "https://ghcr.io/v2/${repository}/manifests/${tag}" || fail "Kubernetes image is not published: $image"
  }
  ask SULLA_DIR "Install directory" /opt/sulla/server
  [[ "$SULLA_DIR" == /* && "$SULLA_DIR" != *$'\n'* ]] || fail "install directory must be an absolute single-line path"
  saved_configuration=false
  if [[ -r "$SULLA_DIR/server.env" ]]; then
    # shellcheck disable=SC1090
    set -a; . "$SULLA_DIR/server.env"; set +a
    saved_configuration=true
    log "Using saved configuration from $SULLA_DIR/server.env."
  fi
  if [[ -z ${SULLA_SOURCE_SHA:-} ]]; then
    commit_json="$(curl -fsSL "https://api.github.com/repos/merchantprotocol/sulla-desktop/commits/${SULLA_REF}")"
    SULLA_SOURCE_SHA="$(sed -n 's/^[[:space:]]*"sha": "\([0-9a-f]\{40\}\)",/\1/p' <<<"$commit_json")"
    SULLA_SOURCE_SHA="${SULLA_SOURCE_SHA%%$'\n'*}"
  fi
  [[ "$SULLA_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "could not resolve SULLA_REF=${SULLA_REF} to a commit"
  if [[ -z ${K3S_URL:-} && "$saved_configuration" == false ]]; then
    ask SULLA_RUNTIME "Runtime (compose or kubernetes)" compose
    default_public_url="http://$(hostname -f 2>/dev/null || hostname):8787"
    [[ "$SULLA_RUNTIME" != kubernetes ]] || default_public_url="http://$(hostname -f 2>/dev/null || hostname)"
    ask SULLA_PUBLIC_URL "Public URL" "$default_public_url"
    ask SULLA_ORGANIZATION "Organization name" "My organization"
    ask SULLA_ADMIN_EMAIL "First admin email" "admin@example.com"
    ask SULLA_ADMIN_NAME "First admin name" Administrator
    case "$SULLA_RUNTIME" in
    compose)
      ask SULLA_PORT "Published port" 8787
      ask SULLA_BIND_ADDRESS "Bind address" 0.0.0.0
      ask SULLA_DATA_DIR "Persistent data directory" "$SULLA_DIR/data"
      ask SULLA_TLS_CERT "TLS certificate path (blank for reverse-proxy TLS)" ""
      ask SULLA_TLS_KEY "TLS private key path (blank for reverse-proxy TLS)" ""
      [[ -z "$SULLA_TLS_CERT" && -z "$SULLA_TLS_KEY" || -n "$SULLA_TLS_CERT" && -n "$SULLA_TLS_KEY" ]] || fail "TLS certificate and private key must be supplied together"
      [[ -z "$SULLA_TLS_CERT" || "$SULLA_PUBLIC_URL" == https://* ]] || fail "direct TLS requires an https public URL"
      [[ -z "$SULLA_TLS_CERT" || -r "$SULLA_TLS_CERT" && -r "$SULLA_TLS_KEY" ]] || fail "TLS certificate or key is not readable"
      ;;
    kubernetes)
      ask SULLA_KUBERNETES_MODE "Cluster (existing context or install new k3s)" existing
      if [[ "$SULLA_KUBERNETES_MODE" == existing ]]; then
        command -v kubectl >/dev/null 2>&1 || fail "kubectl is required for an existing cluster"
        ask SULLA_KUBECONFIG "Kubeconfig path (blank for kubectl default)" "${KUBECONFIG:-}"
        context_command=(kubectl)
        [[ -z "$SULLA_KUBECONFIG" ]] || context_command+=(--kubeconfig "$SULLA_KUBECONFIG")
        detected_context="$("${context_command[@]}" config current-context 2>/dev/null || true)"
        [[ -n "$detected_context" ]] || fail "the selected kubeconfig has no current context"
        ask SULLA_KUBECONTEXT "Kubernetes context" "$detected_context"
      elif [[ "$SULLA_KUBERNETES_MODE" == install ]]; then
        SULLA_KUBECONFIG=/etc/rancher/k3s/k3s.yaml
        SULLA_KUBECONTEXT=default
      else
        fail "Kubernetes cluster choice must be existing or install"
      fi
      ask SULLA_VAULT_IMAGE "Pinned vault image (tag or digest; never latest)" "ghcr.io/merchantprotocol/sulla-vault:sha-${SULLA_SOURCE_SHA:0:12}"
      ask SULLA_STORAGE_CLASS "Storage class" local-path
      ask SULLA_STORAGE_SIZE "PostgreSQL storage size" 20Gi
      ask SULLA_INGRESS_MODE "Ingress (create or existing)" create
      ask SULLA_HOSTNAME "Console hostname" "$(printf '%s' "$SULLA_PUBLIC_URL" | sed -E 's#^[a-z]+://([^/:]+).*#\1#')"
      ask SULLA_TLS_SECRET "Ingress TLS secret (blank for HTTP)" ""
      ;;
      *) fail "runtime must be compose or kubernetes" ;;
    esac
  fi
  if [[ -z ${K3S_URL:-} ]]; then validate_configuration; fi
  RAW="https://raw.githubusercontent.com/merchantprotocol/sulla-desktop/${SULLA_SOURCE_SHA}/deploy/server"
  FILES=(
    install-server.sh join-node.sh deploy-sulla.sh compose.yaml
    k8s/kustomization.yaml k8s/namespace.yaml k8s/storage.yaml
    k8s/postgres.yaml k8s/sulla-vault.yaml
  )

  log "Downloading the Sulla server kit (${SULLA_REF}) to ${SULLA_DIR}..."
  mkdir -p "${SULLA_DIR}/k8s"
  for f in "${FILES[@]}"; do
    curl -fsSL "${RAW}/${f}" -o "${SULLA_DIR}/${f}.tmp" || fail "download failed: ${f}"
    mv "${SULLA_DIR}/${f}.tmp" "${SULLA_DIR}/${f}"
  done
  chmod +x "${SULLA_DIR}"/*.sh
  cd "${SULLA_DIR}"

  if [[ -n "${K3S_URL:-}" ]]; then
    ask_secret K3S_TOKEN "K3S join token"
    [[ -n "${K3S_TOKEN:-}" ]] || fail "a K3S token is required"
    log "Joining this server to ${K3S_URL}..."
    export K3S_URL K3S_TOKEN
    ./join-node.sh </dev/null
    log "Done. This server is now a node in the cluster."
    return 0
  fi

  umask 077
  env_file="$SULLA_DIR/server.env"
  [[ -f "$env_file" ]] || {
    env_tmp="$env_file.tmp"
    postgres_password="$(openssl rand -hex 32)"; jwt_secret="$(openssl rand -base64 48 | tr -d '\n')"; bootstrap_token="$(openssl rand -hex 32)"
    printf 'SULLA_RUNTIME=%q\nSULLA_SOURCE_SHA=%q\nSULLA_PUBLIC_URL=%q\nSULLA_ORGANIZATION=%q\nSULLA_ADMIN_EMAIL=%q\nSULLA_ADMIN_NAME=%q\nSULLA_POSTGRES_PASSWORD=%q\nSULLA_VAULT_JWT_SECRET=%q\nSULLA_VAULT_SERVER_BOOTSTRAP_TOKEN=%q\n' \
      "$SULLA_RUNTIME" "$SULLA_SOURCE_SHA" "$SULLA_PUBLIC_URL" "$SULLA_ORGANIZATION" "$SULLA_ADMIN_EMAIL" "$SULLA_ADMIN_NAME" "$postgres_password" "$jwt_secret" "$bootstrap_token" >"$env_tmp"
    if [[ "$SULLA_RUNTIME" == compose ]]; then
      tls_dir="$SULLA_DIR/tls"; mkdir -p "$tls_dir"
      [[ -z "$SULLA_TLS_CERT" ]] || cp "$SULLA_TLS_CERT" "$tls_dir/tls.crt"
      [[ -z "$SULLA_TLS_KEY" ]] || cp "$SULLA_TLS_KEY" "$tls_dir/tls.key"
      if [[ -n "$SULLA_TLS_CERT" ]]; then chown -R 1000:1000 "$tls_dir"; chmod 700 "$tls_dir"; chmod 600 "$tls_dir"/*; fi
      source_dir="$SULLA_DIR/sources/$SULLA_SOURCE_SHA"
      printf 'SULLA_PORT=%q\nSULLA_BIND_ADDRESS=%q\nSULLA_DATA_DIR=%q\nSULLA_TLS_DIR=%q\nSULLA_TLS_CERT_CONTAINER_PATH=%q\nSULLA_TLS_KEY_CONTAINER_PATH=%q\nSULLA_IMAGE_TAG=%q\nSULLA_SOURCE_DIR=%q\n' "$SULLA_PORT" "$SULLA_BIND_ADDRESS" "$SULLA_DATA_DIR" "$tls_dir" "$([[ -n "$SULLA_TLS_CERT" ]] && echo /run/sulla-tls/tls.crt)" "$([[ -n "$SULLA_TLS_KEY" ]] && echo /run/sulla-tls/tls.key)" "${SULLA_SOURCE_SHA:0:12}" "$source_dir" >>"$env_tmp"
    else
      printf 'SULLA_KUBERNETES_MODE=%q\nSULLA_KUBECONFIG=%q\nSULLA_KUBECONTEXT=%q\nSULLA_VAULT_IMAGE=%q\nSULLA_STORAGE_CLASS=%q\nSULLA_STORAGE_SIZE=%q\nSULLA_INGRESS_MODE=%q\nSULLA_HOSTNAME=%q\nSULLA_TLS_SECRET=%q\n' "$SULLA_KUBERNETES_MODE" "$SULLA_KUBECONFIG" "$SULLA_KUBECONTEXT" "$SULLA_VAULT_IMAGE" "$SULLA_STORAGE_CLASS" "$SULLA_STORAGE_SIZE" "$SULLA_INGRESS_MODE" "$SULLA_HOSTNAME" "$SULLA_TLS_SECRET" >>"$env_tmp"
    fi
    mv "$env_tmp" "$env_file"
  }
  chmod 600 "$env_file"
  # shellcheck disable=SC1090
  set -a; . "$env_file"; set +a
  validate_configuration
  if [[ "$SULLA_RUNTIME" == compose ]]; then
    command -v docker >/dev/null 2>&1 || fail "Docker is required"
    docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
    archive="$SULLA_DIR/sources/$SULLA_SOURCE_SHA.tar.gz"; source_dir="$SULLA_SOURCE_DIR"
    mkdir -p "$SULLA_DIR/sources" "$source_dir"
    if [[ ! -f "$archive" ]]; then curl -fsSL "https://github.com/merchantprotocol/sulla-desktop/archive/${SULLA_SOURCE_SHA}.tar.gz" -o "$archive.tmp"; mv "$archive.tmp" "$archive"; fi
    tar -xzf "$archive" --strip-components=1 -C "$source_dir"
    compose=(docker compose --env-file /dev/null -f "$SULLA_DIR/compose.yaml")
    "${compose[@]}" build --pull vault
    if ! "${compose[@]}" up -d; then
      "${compose[@]}" ps >&2 || true
      "${compose[@]}" logs --tail=100 vault >&2 || true
      fail "Sulla services failed to start"
    fi
    healthy=false; deadline=$((SECONDS + 300))
    while (( SECONDS < deadline )); do
      vault_id="$("${compose[@]}" ps -q vault 2>/dev/null || true)"
      if [[ -n "$vault_id" && "$(docker inspect --format '{{.State.Health.Status}}' "$vault_id" 2>/dev/null || true)" == healthy ]]; then
        healthy=true
        break
      fi
      sleep 2
    done
    if [[ "$healthy" != true ]]; then
      "${compose[@]}" ps >&2 || true
      "${compose[@]}" logs --tail=100 vault >&2 || true
      fail "Sulla services did not become healthy within 5 minutes"
    fi
    bootstrap_url=http://127.0.0.1:8787
    bootstrap_env=()
    if [[ -n ${SULLA_TLS_CERT_CONTAINER_PATH:-} ]]; then
      bootstrap_url=https://127.0.0.1:8787
      bootstrap_env=(-e NODE_TLS_REJECT_UNAUTHORIZED=0 -e NODE_NO_WARNINGS=1)
    fi
    "${compose[@]}" exec "${bootstrap_env[@]}" vault node dist/serverBootstrapCli.js --url "$bootstrap_url" --email "$SULLA_ADMIN_EMAIL" --name "$SULLA_ADMIN_NAME" --organization "$SULLA_ORGANIZATION" <&3
  else
    verify_default_image "$SULLA_VAULT_IMAGE"
    if [[ "$SULLA_KUBERNETES_MODE" == install ]]; then
      ./install-server.sh </dev/null
    fi
    command -v kubectl >/dev/null 2>&1 || fail "kubectl is required"
    kube=(kubectl)
    [[ -z ${SULLA_KUBECONFIG:-} ]] || kube+=(--kubeconfig "$SULLA_KUBECONFIG")
    kube+=(--context "$SULLA_KUBECONTEXT")
    "${kube[@]}" cluster-info >/dev/null 2>&1 || fail "the saved Kubernetes context cannot reach a cluster"
    ./deploy-sulla.sh </dev/null
    "${kube[@]}" -n sulla exec -it deployment/sulla-vault -- node dist/serverBootstrapCli.js --url http://127.0.0.1:8787 --email "$SULLA_ADMIN_EMAIL" --name "$SULLA_ADMIN_NAME" --organization "$SULLA_ORGANIZATION" <&3
  fi
  log "Sulla Server is ready: ${SULLA_PUBLIC_URL%/}/console"
  log "Configuration is stored in ${env_file} (root-readable only)."
}

main "$@"
