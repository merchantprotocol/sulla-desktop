FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=0.162.1

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash build-essential ca-certificates curl git jq openssh-client python3 python3-pip tini \
 && npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && rm -rf /var/lib/apt/lists/* /root/.npm

RUN useradd --create-home --uid 10001 --shell /bin/bash sulla \
 && install -d -o sulla -g sulla /workspace /home/sulla/.codex /home/sulla/.claude

COPY --chmod=0755 resources/darwin/bin/sulla /usr/local/bin/sulla
COPY --chmod=0755 services/sulla-agent/entrypoint.sh /usr/local/bin/sulla-agent-entrypoint

ENV HOME=/home/sulla \
    CODEX_HOME=/home/sulla/.codex \
    SULLA_HOST=host.docker.internal
WORKDIR /workspace
USER sulla

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/sulla-agent-entrypoint"]
