# syntax=docker/dockerfile:1.7
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Sulla threat proxy: mitmdump in transparent mode with the Sulla URL-reputation
# and prompt-injection addons. Built from the repository root:
#   docker build -f services/sulla-threat-proxy/Dockerfile .
ARG PYTHON_IMAGE=python:3.13.17-slim-bookworm@sha256:e32be0e55814a08977501ca863271d9bd02443710db8f2afaf8372e2c4508530

FROM ${PYTHON_IMAGE} AS base
ARG MITMPROXY_VERSION=12.3.1
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
RUN pip install "mitmproxy==${MITMPROXY_VERSION}"
COPY services/sulla-threat-proxy/addons /opt/sulla-threat-proxy/addons
COPY --chmod=0755 services/sulla-threat-proxy/entrypoint.sh /usr/local/bin/sulla-threat-proxy

# The addon tests gate the published image: the final stage copies the marker
# this stage writes, so a failing test fails the build.
FROM base AS test
COPY services/sulla-threat-proxy/tests /opt/sulla-threat-proxy/tests
RUN cd /opt/sulla-threat-proxy \
 && SULLA_PROXY_NO_AUTOLOAD=1 PYTHONPATH=/opt/sulla-threat-proxy/addons python -m unittest discover -s tests -v \
 && touch /tmp/tests-passed

FROM base
COPY --from=test /tmp/tests-passed /opt/sulla-threat-proxy/.tests-passed
# Fixed UID: Desktop provisions the state directories on the data disk for it
# (THREAT_PROXY_UID in pkg/sulla-desktop/backend/threatProxyEgress.ts).
RUN groupadd --system --gid 10010 sulla-proxy \
 && useradd --system --uid 10010 --gid 10010 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin sulla-proxy
ENV SULLA_PROXY_STATE_DIR=/var/lib/sulla-threat-proxy \
    SULLA_PROXY_LISTEN_PORT=8890 \
    SULLA_PROXY_MODE=transparent \
    PYTHONPATH=/opt/sulla-threat-proxy/addons
USER 10010:10010
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["python3", "-c", "import os, socket; socket.create_connection(('127.0.0.1', int(os.environ.get('SULLA_PROXY_LISTEN_PORT', '8890'))), 2).close()"]
ENTRYPOINT ["/usr/local/bin/sulla-threat-proxy"]
