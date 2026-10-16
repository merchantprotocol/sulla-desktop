#!/bin/sh
set -eu

# Credentials are injected only for this container. Decode into its ephemeral
# filesystem, then erase the transport variables before starting the model CLI.
if [ -n "${CODEX_AUTH_JSON_B64:-}" ]; then
  install -d -m 700 "$CODEX_HOME"
  printf '%s' "$CODEX_AUTH_JSON_B64" | base64 -d > "$CODEX_HOME/auth.json"
  chmod 600 "$CODEX_HOME/auth.json"
  unset CODEX_AUTH_JSON_B64
fi

if [ -n "${SULLA_AGENT_INSTRUCTIONS_B64:-}" ]; then
  printf '%s' "$SULLA_AGENT_INSTRUCTIONS_B64" | base64 -d > /tmp/sulla-agent-instructions.md
  chmod 600 /tmp/sulla-agent-instructions.md
  unset SULLA_AGENT_INSTRUCTIONS_B64
fi

case "${SULLA_AGENT_PROVIDER:-}" in
  codex)
    if [ -n "${SULLA_AGENT_MODEL:-}" ]; then
      set -- codex exec -c shell_environment_policy.inherit=all \
        --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --json \
        -c 'features.multi_agent=false' -c 'features.multi_agent_v2=false' \
        -c 'model_instructions_file="/tmp/sulla-agent-instructions.md"' \
        --model "$SULLA_AGENT_MODEL" -
    else
      set -- codex exec -c shell_environment_policy.inherit=all \
        --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --json \
        -c 'features.multi_agent=false' -c 'features.multi_agent_v2=false' \
        -c 'model_instructions_file="/tmp/sulla-agent-instructions.md"' -
    fi
    ;;
  claude-code)
    if [ -n "${SULLA_AGENT_MODEL:-}" ]; then
      set -- claude -p --output-format stream-json --verbose --include-partial-messages \
        --dangerously-skip-permissions --input-format stream-json \
        --append-system-prompt-file /tmp/sulla-agent-instructions.md --model "$SULLA_AGENT_MODEL"
    else
      set -- claude -p --output-format stream-json --verbose --include-partial-messages \
        --dangerously-skip-permissions --input-format stream-json \
        --append-system-prompt-file /tmp/sulla-agent-instructions.md
    fi
    ;;
  *)
    echo "Unsupported SULLA_AGENT_PROVIDER=${SULLA_AGENT_PROVIDER:-}" >&2
    exit 64
    ;;
esac

exec "$@"
