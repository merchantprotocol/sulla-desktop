#!/bin/sh
set -eu

# The launcher rotates these lease files while a long-running worker is alive.
# Read them for every tool call so the model process never holds an expired
# capability or graph session in its inherited startup environment.
secret_dir=/run/secrets/sulla-agent
for secret_name in SULLA_API_TOKEN SULLA_TOOL_SESSION; do
  secret_file="$secret_dir/$secret_name"
  if [ -f "$secret_file" ]; then
    secret_value=$(cat "$secret_file")
    export "$secret_name=$secret_value"
    unset secret_value
  fi
done

exec /usr/local/libexec/sulla-remote "$@"
